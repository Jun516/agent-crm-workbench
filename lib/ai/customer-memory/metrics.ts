import type { Pool } from "pg";
import { z } from "zod";
import { withMemoryContact, assertMemoryAuthority } from "./authority";

const count = z.coerce.number().int().nonnegative();
const duration = z.coerce.number().nonnegative().nullable();
const rate = z.coerce.number().min(0).max(1).nullable();
export const customerMemoryMetricsSchema = z
  .object({
    as_of: z.preprocess(
      (v) => (v instanceof Date ? v.toISOString() : v),
      z.iso.datetime({ offset: true }),
    ),
    confirmed_count: count,
    rejected_count: count,
    decided_count: count,
    confirmation_rate: rate,
    rejection_rate: rate,
    confirmation_latency_sample_count: count,
    median_confirmation_seconds: duration,
    pending_count: count,
    pending_over_7d_count: count,
    open_conflict_count: count,
    oldest_open_conflict_seconds: duration,
    median_open_conflict_seconds: duration,
    median_resolved_conflict_seconds: duration,
    used_report_count: count,
    corrected_report_count: count,
    report_correction_rate: rate,
    used_draft_count: count,
    corrected_draft_count: count,
    draft_correction_rate: rate,
  })
  .strict();
export type CustomerMemoryMetrics = z.infer<typeof customerMemoryMetricsSchema>;

/** Manager-only, one SQL snapshot. No excerpts, prompts or private customer facts. */
export async function loadCustomerMemoryMetrics(
  pool: Pool,
  org: string,
  actor: string,
  contact: string,
) {
  return withMemoryContact(pool, org, contact, async (db) => {
    await assertMemoryAuthority(db, org, contact, actor, "arbitrate");
    const result = await db.query(
      `with candidates as (
      select status,created_at,decided_at from ai_customer_memory_candidates
      where organization_id=$1 and contact_id=$2 and deleted_at is null
    ), decisions as (
      select count(*) filter(where status='confirmed') confirmed_count,
        count(*) filter(where status='rejected') rejected_count,
        count(*) filter(where status in ('confirmed','rejected')) decided_count,
        count(*) filter(where status='pending') pending_count,
        count(*) filter(where status='pending' and created_at<now()-interval '7 days') pending_over_7d_count,
        count(*) filter(where status='confirmed' and decided_at is not null) confirmation_latency_sample_count,
        percentile_cont(0.5) within group(order by greatest(0,extract(epoch from decided_at-created_at)))
          filter(where status='confirmed' and decided_at is not null) median_confirmation_seconds
      from candidates
    ), conflicts as (
      select c.status,c.created_at,c.resolved_at from ai_customer_memory_conflicts c
      join ai_customer_memories m on m.organization_id=c.organization_id and m.contact_id=c.contact_id and m.id=c.memory_id
      where c.organization_id=$1 and c.contact_id=$2 and m.deleted_at is null
    ), conflict_stats as (
      select count(*) filter(where status='open') open_conflict_count,
        max(greatest(0,extract(epoch from now()-created_at))) filter(where status='open') oldest_open_conflict_seconds,
        percentile_cont(0.5) within group(order by greatest(0,extract(epoch from now()-created_at))) filter(where status='open') median_open_conflict_seconds,
        percentile_cont(0.5) within group(order by greatest(0,extract(epoch from resolved_at-created_at))) filter(where status='resolved' and resolved_at is not null) median_resolved_conflict_seconds
      from conflicts
    ), reports as (
      select coalesce(w.parent_run_id,w.id) artifact,bool_or(u.corrected_at is not null) corrected
      from ai_customer_memory_usage u
      join ai_customer_memory_recalls r on r.organization_id=u.organization_id and r.contact_id=u.contact_id and r.id=u.recall_id
      join ai_workbench_runs w on w.organization_id=u.organization_id and w.id=r.run_id
      where u.organization_id=$1 and u.contact_id=$2 group by coalesce(w.parent_run_id,w.id)
    ), drafts as (
      select r.draft_id artifact,bool_or(u.corrected_at is not null) corrected
      from ai_customer_memory_usage u
      join ai_customer_memory_recalls r on r.organization_id=u.organization_id and r.contact_id=u.contact_id and r.id=u.recall_id
      where u.organization_id=$1 and u.contact_id=$2 and r.draft_id is not null group by r.draft_id
    ), usage_stats as (
      select (select count(*) from reports) used_report_count,
        (select count(*) from reports where corrected) corrected_report_count,
        (select count(*) from drafts) used_draft_count,
        (select count(*) from drafts where corrected) corrected_draft_count
    ) select now() as_of, d.*,
      d.confirmed_count::numeric/nullif(d.decided_count,0) confirmation_rate,
      d.rejected_count::numeric/nullif(d.decided_count,0) rejection_rate,
      c.*,u.*,u.corrected_report_count::numeric/nullif(u.used_report_count,0) report_correction_rate,
      u.corrected_draft_count::numeric/nullif(u.used_draft_count,0) draft_correction_rate
      from decisions d cross join conflict_stats c cross join usage_stats u`,
      [org, contact],
    );
    return customerMemoryMetricsSchema.parse(result.rows[0]);
  });
}
