import type { Pool } from "pg";
import { z } from "zod";
import type { MemoryEvaluationRecall } from "@/lib/ai/evals/contracts";
const receipt = z
  .object({
    recall_id: z.uuid(),
    contact_id: z.uuid(),
    as_of: z.preprocess(
      (v) => (v instanceof Date ? v.toISOString() : v),
      z.iso.datetime({ offset: true }),
    ),
    coverage: z.enum(["complete", "partial", "unavailable"]),
    provider_status: z.string(),
    scope_valid: z.boolean(),
    memory_ids: z.array(z.uuid()),
    required_memory_ids: z.array(z.uuid()),
    invalid_memory_ids: z.array(z.uuid()),
    metadata_error_count: z.coerce.number().int().nonnegative(),
    uncertain_policy_count: z.coerce.number().int().nonnegative(),
    returned_count: z.number().int().nonnegative(),
  })
  .strict();
/** Evaluates historical policy only where its current SQL revision predates injection.
 * Later human edits are uncertainty, never fabricated proof of a past violation. */
export async function loadMemoryEvaluationRecalls(
  pool: Pool,
  org: string,
  runIds: string[],
): Promise<MemoryEvaluationRecall[]> {
  if (!runIds.length) return [];
  const result = await pool.query(
    `select r.id recall_id,r.contact_id,r.injected_at as_of,r.coverage,r.provider_status,r.returned_count,
    (w.scope->>'contactId'=r.contact_id::text) scope_valid,
    array(select u.memory_id from ai_customer_memory_usage u where u.organization_id=r.organization_id and u.contact_id=r.contact_id and u.recall_id=r.id order by u.memory_id) memory_ids,
    array(select m.id from ai_customer_memories m where m.organization_id=r.organization_id and m.contact_id=r.contact_id and m.locked
      and m.created_at<=r.injected_at and m.updated_at<=r.injected_at and (m.deleted_at is null or m.deleted_at>r.injected_at)
      and (m.ttl_expires_at is null or m.ttl_expires_at>r.injected_at) order by m.id) required_memory_ids,
    array(select u.memory_id from ai_customer_memory_usage u join ai_customer_memories m on m.organization_id=u.organization_id and m.contact_id=u.contact_id and m.id=u.memory_id
      where u.organization_id=r.organization_id and u.contact_id=r.contact_id and u.recall_id=r.id and m.updated_at<=r.injected_at
      and (m.content_hash<>u.memory_revision or m.created_at>r.injected_at or m.deleted_at<=r.injected_at or m.ttl_expires_at<=r.injected_at) order by u.memory_id) invalid_memory_ids,
    (select count(*) from ai_customer_memory_usage u join ai_customer_memories m on m.organization_id=u.organization_id and m.contact_id=u.contact_id and m.id=u.memory_id
      where u.organization_id=r.organization_id and u.contact_id=r.contact_id and u.recall_id=r.id and m.updated_at<=r.injected_at and m.policy_revision=u.policy_revision
      and (u.locked is distinct from m.locked or u.memory_type is distinct from m.memory_type or u.risk_level is distinct from m.risk_level
        or ((m.needs_review or m.review_due_at<=r.injected_at) and not coalesce(u.needs_review,false)))) metadata_error_count,
    (select count(*) from ai_customer_memories m where m.organization_id=r.organization_id and m.contact_id=r.contact_id
      and m.created_at<=r.injected_at and m.updated_at>r.injected_at) uncertain_policy_count
    from ai_customer_memory_recalls r join ai_workbench_runs w on w.organization_id=r.organization_id and w.id=r.run_id
    join contacts c on c.organization_id=r.organization_id and c.id=r.contact_id and not c.is_anonymized and c.is_merged_into is null
    where r.organization_id=$1 and r.run_id=any($2::uuid[]) order by r.injected_at,r.id limit 501`,
    [org, runIds],
  );
  if (result.rows.length > 500) throw new Error("customer_memory_evaluation_material_overflow");
  const parsed = z
    .array(receipt)
    .parse(result.rows.map((r) => ({ ...r, scope_valid: r.scope_valid === true })));
  if (!parsed.length) return [];
  const current = await pool.query<{ id: string }>(
    "select id from contacts where organization_id=$1 and id=any($2::uuid[]) and not is_anonymized and is_merged_into is null",
    [org, [...new Set(parsed.map((r) => r.contact_id))]],
  );
  const allowed = new Set(current.rows.map((r) => r.id));
  return parsed.filter((r) => allowed.has(r.contact_id));
}
