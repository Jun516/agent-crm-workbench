import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { withMemoryContact } from "./authority";
import { candidateFingerprint, type ProposeMemoryInput } from "./candidates";
import { assertMemoryJobLease, recordMemoryJobResult } from "./jobs";
import { loadCustomerBusinessFacts } from "./business-facts";
import { recordMemoryAudit } from "./audit";

interface PendingRow {
  id: string;
  created_at: Date;
  cursor_at: string;
  normalized_hash: string;
  body: string;
  memory_type: ProposeMemoryInput["memory_type"];
  attribute_key: string | null;
  attribute_value: string | null;
  ttl_expires_at: Date | null;
}
async function mergePending(
  db: PoolClient,
  org: string,
  contact: string,
  source: string,
  target: string,
) {
  await db.query(
    `insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,conversation_id,message_id,excerpt,observed_at)
    select e.organization_id,e.contact_id,$4,e.conversation_id,e.message_id,e.excerpt,e.observed_at
    from ai_customer_memory_evidence e where e.organization_id=$1 and e.contact_id=$2 and e.candidate_id=$3
    and not exists(select 1 from ai_customer_memory_evidence t where t.organization_id=$1 and t.contact_id=$2 and t.candidate_id=$4
      and t.message_id is not distinct from e.message_id and t.excerpt=e.excerpt) on conflict do nothing`,
    [org, contact, source, target],
  );
  const conflicts = await db.query<{ memory_id: string }>(
    "select memory_id from ai_customer_memory_conflicts where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'",
    [org, contact, source],
  );
  for (const row of conflicts.rows)
    await db.query(
      `insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,candidate_id,kind,conflict_key)
    values($1,$2,$3,$4,'l2_l1',$5) on conflict do nothing`,
      [org, contact, row.memory_id, target, `candidate:${target}:${row.memory_id}`],
    );
  await db.query(
    `update ai_customer_memory_candidates set status='merged',merged_into=$4,decision_reason='exact_duplicate_consolidated',decided_at=now(),updated_at=now()
    where organization_id=$1 and contact_id=$2 and id=$3 and status='pending'`,
    [org, contact, source, target],
  );
  await db.query(
    `update ai_customer_memory_conflicts set status='resolved',resolution='candidate_consolidated',resolved_at=now()
    where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'`,
    [org, contact, source],
  );
  await db.query(
    "update ai_customer_memory_candidates set updated_at=now() where organization_id=$1 and contact_id=$2 and id=$3",
    [org, contact, target],
  );
}

/** No discovery or promotion here. Confirmed bodies/locks are never rewritten by consolidation. */
export async function runCustomerMemoryConsolidation(pool: Pool, job: JobRow, workerId: string) {
  const input = z
    .object({ contact_id: z.string().uuid(), run_after: z.iso.datetime({ offset: true }) })
    .strict()
    .parse(job.payload.source);
  if (job.contact_id !== input.contact_id) throw new Error("customer_memory_source_scope_invalid");
  await assertMemoryJobLease(pool, job, workerId);
  const contact = await pool.query(
    "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
    [job.organization_id, input.contact_id],
  );
  if (!contact.rows.length) {
    await recordMemoryJobResult(pool, job, workerId, {
      status: "skipped",
      reason: "customer_unavailable",
    });
    return;
  }
  // Schedule the next night BEFORE cleaning. A failure later must not kill the recurring loop.
  await pool.query("select public.fn_ai_memory_schedule_night($1,$2)", [
    job.organization_id,
    input.contact_id,
  ]);
  const result = await withMemoryContact(
    pool,
    job.organization_id,
    input.contact_id,
    async (db) => {
      await assertMemoryJobLease(db, job, workerId);
      const expired = await db.query(
        `with retired as (
      update ai_customer_memories set body='',attribute_key=null,attribute_value=null,deleted_at=now(),sync_state='deleted',
        remote_deleted_at=case when write_outcome='never_started' then now() else remote_deleted_at end,
        review_reason='expired',updated_at=now(),policy_revision=policy_revision+1
      where organization_id=$1 and contact_id=$2 and deleted_at is null and not locked
        and retention_policy='ephemeral' and ttl_expires_at<=now() returning id
    ) insert into event_log(organization_id,event_type,entity_kind,entity_id,payload)
      select $1,'ai_integration.mem0_sync','ai_customer_memory',id,jsonb_build_object('memory_id',id) from retired returning entity_id`,
        [job.organization_id, input.contact_id],
      );
      const reviewDue = await db.query(
        `update ai_customer_memories set needs_review=true,review_reason='review_due',policy_revision=policy_revision+1,updated_at=now()
      where organization_id=$1 and contact_id=$2 and deleted_at is null and retention_policy='durable'
        and review_due_at<=now() and not needs_review returning id`,
        [job.organization_id, input.contact_id],
      );
      const targetByFingerprint = new Map<string, string>();
      const clusters = new Set<string>();
      let cursor: { at: string; id: string } | null = null;
      const repair = new Map<string, string>();
      let merged = 0;
      while (true) {
        const page: QueryResult<PendingRow> = await db.query<PendingRow>(
          `select id,created_at,created_at::text cursor_at,normalized_hash,body,memory_type,attribute_key,attribute_value,ttl_expires_at from ai_customer_memory_candidates
         where organization_id=$1 and contact_id=$2 and status='pending' and deleted_at is null
           and ($3::timestamptz is null or (created_at,id)>($3::timestamptz,$4::uuid))
         order by created_at,id limit 200 for update`,
          [job.organization_id, input.contact_id, cursor?.at ?? null, cursor?.id ?? null],
        );
        for (const row of page.rows) {
          const fingerprint = candidateFingerprint({
            memory_type: row.memory_type,
            body: row.body,
            attribute_key: row.attribute_key ?? undefined,
            attribute_value: row.attribute_value ?? undefined,
            ttl_expires_at: row.ttl_expires_at?.toISOString() ?? null,
          });
          clusters.add(`${row.memory_type}:${row.attribute_key ?? "unclassified"}`);
          const target = targetByFingerprint.get(fingerprint);
          if (target) {
            await mergePending(db, job.organization_id, input.contact_id, row.id, target);
            merged++;
          } else {
            targetByFingerprint.set(fingerprint, row.id);
            if (row.normalized_hash !== fingerprint) repair.set(row.id, fingerprint);
          }
        }
        if (page.rows.length < 200) break;
        const last: PendingRow = page.rows.at(-1)!;
        cursor = { at: last.cursor_at, id: last.id };
      }
      if (repair.size) {
        await db.query(
          `update ai_customer_memory_candidates set normalized_hash=encode(extensions.digest('memory-normalizing:'||id::text,'sha256'),'hex')
          where organization_id=$1 and contact_id=$2 and id=any($3::uuid[]) and status='pending'`,
          [job.organization_id, input.contact_id, [...repair.keys()]],
        );
        await db.query(
          `update ai_customer_memory_candidates c set normalized_hash=x.fingerprint,updated_at=now()
          from jsonb_to_recordset($3::jsonb) x(id uuid,fingerprint text)
          where c.organization_id=$1 and c.contact_id=$2 and c.id=x.id and c.status='pending'`,
          [
            job.organization_id,
            input.contact_id,
            JSON.stringify([...repair].map(([id, fingerprint]) => ({ id, fingerprint }))),
          ],
        );
      }
      return {
        status: "completed",
        normalized: repair.size,
        expired: expired.rowCount ?? 0,
        review_due: reviewDue.rowCount ?? 0,
        merged,
        clusters: clusters.size,
      };
    },
  );
  // Compare current L0/L1 separately through the gateway, not an unattended truth-writing task.
  const memories = await pool.query(
    `select count(*)::int count,encode(extensions.digest(coalesce(string_agg(id::text||':'||content_hash||':'||policy_revision::text,',' order by id),''),'sha256'),'hex') fingerprint
     from ai_customer_memories where organization_id=$1 and contact_id=$2
     and deleted_at is null and (ttl_expires_at is null or ttl_expires_at>now())`,
    [job.organization_id, input.contact_id],
  );
  const business = await loadCustomerBusinessFacts(pool, job.organization_id, input.contact_id);
  if (memories.rows[0].count && (business.facts.length || memories.rows[0].count > 1)) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          memories: memories.rows[0].fingerprint,
          business: business.facts.map((f) => [f.kind, f.id, f.revision]),
        }),
      )
      .digest("hex");
    await pool.query(
      "select public.fn_ai_memory_emit_extract($1,$2,'maintenance_review',null,null,now(),null,now(),$3)",
      [job.organization_id, input.contact_id, fingerprint],
    );
  }
  await recordMemoryJobResult(pool, job, workerId, result);
  if (result.expired || result.review_due || result.merged || result.normalized)
    await recordMemoryAudit(
      pool,
      job.organization_id,
      input.contact_id,
      "ai.customer_memory_consolidated",
      { job_id: job.id, ...result },
    );
}
