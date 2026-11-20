import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Queryable, JobRow } from "@/lib/agent-engine/queue/queue";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { withMemoryContact } from "./authority";
import { memoryReviewPageSchema, type MemoryReviewPage } from "./review-pages";

export const memoryExtractionSource = z
  .object({
    contact_id: z.string().uuid(),
    source_kind: z.enum([
      "conversation_close",
      "checkpoint",
      "workbench_complete",
      "business_change",
      "maintenance_review",
    ]),
    conversation_id: z.string().uuid().nullable(),
    service_revision: z.number().int().nonnegative().nullable(),
    until_at: z.iso.datetime({ offset: true }),
    source_run_id: z.string().uuid().nullable(),
    run_after: z.iso.datetime({ offset: true }),
    review_root: z.uuid().optional(),
    review_page: memoryReviewPageSchema.optional(),
  })
  .strict()
  .refine(
    (source) =>
      !source.review_page ||
      (Boolean(source.review_root) &&
        ["maintenance_review", "business_change"].includes(source.source_kind) &&
        source.conversation_id === null &&
        source.service_revision === null),
    "Invalid review continuation",
  );
export type MemoryExtractionSource = z.infer<typeof memoryExtractionSource>;
const nightlySource = z
  .object({ contact_id: z.string().uuid(), run_after: z.iso.datetime({ offset: true }) })
  .strict();

/** Lock the exact acquisition while committing a write; an old worker cannot outlive a reaper. */
export async function assertMemoryJobLease(db: Queryable, job: JobRow, workerId: string) {
  const claim = claimOfJob(job);
  if (!claim || claim.worker_id !== workerId) throw new Error("customer_memory_job_claim_missing");
  const found = await db.query(
    `select id from job_queue where organization_id=$1 and id=$2 and status='running'
     and locked_by=$3 and locked_at=$4::timestamptz for share`,
    [job.organization_id, job.id, workerId, claim.acquired_at],
  );
  if (!found.rows.length) throw new Error("customer_memory_job_claim_lost");
}
export async function recordMemoryJobResult(
  pool: Queryable,
  job: JobRow,
  workerId: string,
  result: Record<string, unknown>,
) {
  const claim = claimOfJob(job);
  const done = await pool.query(
    `update job_queue set payload=jsonb_set(payload,'{memory_result}',$5::jsonb)
     where organization_id=$1 and id=$2 and status='running' and locked_by=$3 and locked_at=$4::timestamptz returning id`,
    [job.organization_id, job.id, workerId, claim?.acquired_at ?? null, JSON.stringify(result)],
  );
  if (!done.rows.length) throw new Error("customer_memory_job_claim_lost");
}

/** Result and the next durable event share one contact/lease-fenced transaction. */
export async function finishCustomerMemoryReviewPage(
  pool: Pool,
  job: JobRow,
  workerId: string,
  source: MemoryExtractionSource,
  next: MemoryReviewPage | null,
  result: Record<string, unknown>,
) {
  if (job.contact_id !== source.contact_id) throw new Error("customer_memory_source_scope_invalid");
  return withMemoryContact(pool, job.organization_id, source.contact_id, async (db) => {
    await assertMemoryJobLease(db, job, workerId);
    let eventId: string | null = null;
    if (next) {
      const root = source.review_root ?? job.source_event_id ?? job.id;
      const payload = { ...source, review_root: root, review_page: next };
      const hash = createHash("sha256")
        .update(`memory-review-page:v1:${job.organization_id}:${root}:${JSON.stringify(next)}`)
        .digest("hex");
      eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      await db.query(
        `insert into event_log(id,organization_id,event_type,entity_kind,entity_id,payload)
        values($1,$2,'customer_memory.extract','contact',$3,$4) on conflict(id) do nothing`,
        [eventId, job.organization_id, source.contact_id, payload],
      );
    }
    await recordMemoryJobResult(db, job, workerId, {
      ...result,
      review_complete: result.status === "completed" && !next,
      review_next_event_id: eventId,
    });
  });
}
export function createCustomerMemoryQueueHandler(
  poolFactory: () => Pool = getRequestPool,
): EventHandler {
  return {
    key: "customer_memory.queue.v1",
    lane: "business",
    events: ["customer_memory.extract", "customer_memory.consolidate"],
    async handle(event) {
      const data =
        event.event_type === "customer_memory.extract"
          ? memoryExtractionSource.parse(event.payload)
          : nightlySource.parse(event.payload);
      if (event.entity_kind !== "contact" || event.entity_id !== data.contact_id)
        throw new Error("customer_memory_event_scope_invalid");
      const pool = poolFactory();
      const contact = await pool.query(
        "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
        [event.organization_id, data.contact_id],
      );
      if (!contact.rows.length)
        return { consumer_key: this.key, status: "skipped", detail: "customer_unavailable" };
      const queued = await enqueueJob(pool, event.organization_id, {
        kind:
          event.event_type === "customer_memory.extract"
            ? "customer_memory_extract"
            : "customer_memory_consolidate",
        leadId: data.contact_id,
        sourceEventId: event.id,
        payload: { source: data },
        priority: 200,
        runAfter: new Date(data.run_after),
      });
      return {
        consumer_key: this.key,
        status: "ok",
        detail: queued.deduped ? "already_queued" : "queued",
      };
    },
  };
}
export const customerMemoryQueueHandler = createCustomerMemoryQueueHandler();
