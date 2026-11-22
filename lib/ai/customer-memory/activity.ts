import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { assertMemoryAuthority, withMemoryContact } from "./authority";
import { memoryExtractionSource } from "./jobs";
import type { MemoryActivityView } from "./view";

export const memoryActivityPosition = z
  .object({ at: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
export const memoryActivityRetry = z
  .object({
    contact_id: z.uuid(),
    job_id: z.uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    request_key: z.uuid(),
  })
  .strict();
export interface MemoryActivityAccess {
  conversations: (ids: string[]) => Promise<Set<string>>;
  runs: (ids: string[]) => Promise<Set<string>>;
}
type Row = JobRow & { cursor_at: string };
type Source = { kind: string; conversation: string | null; run: string | null };
const nightly = z
  .object({ contact_id: z.uuid(), run_after: z.iso.datetime({ offset: true }) })
  .strict();
function source(row: JobRow, contact: string): Source | null {
  if (row.kind === "customer_memory_extract") {
    const parsed = memoryExtractionSource.safeParse(row.payload.source);
    if (!parsed.success || parsed.data.contact_id !== contact) return null;
    return {
      kind: parsed.data.source_kind,
      conversation: parsed.data.conversation_id,
      run: parsed.data.source_run_id,
    };
  }
  if (row.kind === "customer_memory_consolidate") {
    const parsed = nightly.safeParse(row.payload.source);
    if (parsed.success && parsed.data.contact_id === contact)
      return { kind: "nightly", conversation: null, run: null };
  }
  return null;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const iso = (v: Date | string) => new Date(v).toISOString();
const revision = (r: JobRow) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        r.id,
        r.status,
        r.attempts,
        iso(r.run_after),
        r.locked_at ? iso(r.locked_at) : null,
        object(r.payload.manual_retry).request_key ?? null,
        object(r.payload.memory_result).status ?? null,
      ]),
    )
    .digest("hex");
function project(row: JobRow, s: Source): MemoryActivityView {
  const result = object(row.payload.memory_result);
  const state: MemoryActivityView["state"] =
    row.status === "pending"
      ? "queued"
      : row.status === "running"
        ? "running"
        : row.status === "failed"
          ? "retry_wait"
          : row.status === "dead"
            ? "failed"
            : result.status === "unavailable"
              ? "unavailable"
              : result.status === "skipped"
                ? "skipped"
                : result.status === "completed"
                  ? typeof result.review_next_event_id === "string"
                    ? "continuing"
                    : "completed"
                  : "unverified";
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return {
    id: row.id,
    revision: revision(row),
    kind: row.kind as MemoryActivityView["kind"],
    source_kind: s.kind,
    state,
    created_at: iso(row.created_at),
    run_after: iso(row.run_after),
    candidates: count(result.candidates),
    conflicts: count(result.conflicts),
    retryable: ["retry_wait", "failed", "unavailable"].includes(state),
  };
}
/** Lock source rows while consulting session RLS, so privacy/assignment cannot change mid-check. */
async function visibleSources(
  db: PoolClient,
  org: string,
  contact: string,
  sources: Source[],
  access: MemoryActivityAccess,
) {
  const conversations = [
    ...new Set(sources.flatMap((s) => (s.conversation ? [s.conversation] : []))),
  ];
  const runs = [...new Set(sources.flatMap((s) => (s.run ? [s.run] : [])))];
  const c = conversations.length
    ? (
        await db.query<{ id: string }>(
          "select id from conversations where organization_id=$1 and contact_id=$2 and id=any($3::uuid[]) for share",
          [org, contact, conversations],
        )
      ).rows
    : [];
  const r = runs.length
    ? (
        await db.query<{ id: string }>(
          "select id from ai_workbench_runs where organization_id=$1 and scope->>'contactId'=$2::text and id=any($3::uuid[]) for share",
          [org, contact, runs],
        )
      ).rows
    : [];
  const allowedC = await access.conversations(c.map((x) => x.id)),
    allowedR = await access.runs(r.map((x) => x.id));
  const existingC = new Set(c.map((x) => x.id)),
    existingR = new Set(r.map((x) => x.id));
  return (s: Source) =>
    (!s.conversation || (existingC.has(s.conversation) && allowedC.has(s.conversation))) &&
    (!s.run || (existingR.has(s.run) && allowedR.has(s.run)));
}

export async function loadCustomerMemoryActivity(
  pool: Pool,
  org: string,
  actor: string,
  contact: string,
  after: z.infer<typeof memoryActivityPosition> | null,
  access: MemoryActivityAccess,
) {
  return withMemoryContact(pool, org, contact, async (db) => {
    await assertMemoryAuthority(db, org, contact, actor, "propose");
    let canRetry = false;
    try {
      await assertMemoryAuthority(db, org, contact, actor, "confirm");
      canRetry = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "customer_memory_owner_required")
        throw error;
    }
    const visible: Array<{
      view: MemoryActivityView;
      position: z.infer<typeof memoryActivityPosition>;
    }> = [];
    let cursor = after;
    for (let batch = 0; batch < 5; batch++) {
      const rows = (
        await db.query<Row>(
          `select *,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
        from job_queue where organization_id=$1 and contact_id=$2 and kind in ('customer_memory_extract','customer_memory_consolidate')
        and ($3::timestamptz is null or (created_at,id)<($3,$4::uuid)) order by created_at desc,id desc limit 100`,
          [org, contact, cursor?.at ?? null, cursor?.id ?? null],
        )
      ).rows;
      const parsed = rows.map((r) => ({ row: r, source: source(r, contact) }));
      const allowed = await visibleSources(
        db,
        org,
        contact,
        parsed.flatMap((r) => (r.source ? [r.source] : [])),
        access,
      );
      for (const item of parsed) {
        if (!item.source || !allowed(item.source)) continue;
        visible.push({
          view: project(item.row, item.source),
          position: { at: item.row.cursor_at, id: item.row.id },
        });
        if (visible.length === 21)
          return {
            rows: visible.slice(0, 20).map((v) => v.view),
            cursor: visible[19]!.position,
            has_more: true,
            coverage: "complete" as const,
            can_retry: canRetry,
          };
      }
      if (rows.length < 100)
        return {
          rows: visible.map((v) => v.view),
          cursor: null,
          has_more: false,
          coverage: "complete" as const,
          can_retry: canRetry,
        };
      cursor = { at: rows.at(-1)!.cursor_at, id: rows.at(-1)!.id };
    }
    return {
      rows: visible.map((v) => v.view),
      cursor,
      has_more: true,
      coverage: "partial" as const,
      can_retry: canRetry,
    };
  });
}

export async function retryCustomerMemoryActivity(
  pool: Pool,
  org: string,
  actor: string,
  input: z.infer<typeof memoryActivityRetry>,
  access: MemoryActivityAccess,
) {
  return withMemoryContact(pool, org, input.contact_id, async (db) => {
    await assertMemoryAuthority(db, org, input.contact_id, actor, "confirm");
    const row = (
      await db.query<JobRow>(
        "select * from job_queue where organization_id=$1 and contact_id=$2 and id=$3 and kind in ('customer_memory_extract','customer_memory_consolidate') for update",
        [org, input.contact_id, input.job_id],
      )
    ).rows[0];
    const s = row ? source(row, input.contact_id) : null;
    if (!row || !s) throw new Error("customer_memory_job_unavailable");
    if (!(await visibleSources(db, org, input.contact_id, [s], access))(s))
      throw new Error("customer_memory_source_unavailable");
    if (object(row.payload.manual_retry).request_key === input.request_key)
      return { id: row.id, status: row.status, deduped: true };
    if (revision(row) !== input.revision) throw new Error("customer_memory_job_stale");
    if (!project(row, s).retryable) throw new Error("customer_memory_job_not_retryable");
    const count = object(row.payload.manual_retry).count;
    const retry = {
      request_key: input.request_key,
      actor_user_id: actor,
      at: new Date().toISOString(),
      count: typeof count === "number" && Number.isSafeInteger(count) ? count + 1 : 1,
    };
    await db.query(
      `update job_queue set status='pending',attempts=0,locked_by=null,locked_at=null,last_error=null,run_after=now(),
      payload=jsonb_set(payload,'{manual_retry}',$4::jsonb,true) where organization_id=$1 and contact_id=$2 and id=$3`,
      [org, input.contact_id, row.id, JSON.stringify(retry)],
    );
    return { id: row.id, status: "pending" as const, deduped: false };
  });
}
