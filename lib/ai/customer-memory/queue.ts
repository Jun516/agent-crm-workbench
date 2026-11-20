import type { Pool } from "pg";
import { z } from "zod";
export const candidatePosition = z
  .object({
    rank: z.number().int().min(0).max(1),
    at: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();
export type CandidatePosition = z.infer<typeof candidatePosition>;
const view = z
  .object({
    id: z.string(),
    source_kind: z.string(),
    source_conversation_ids: z.array(z.uuid()).optional(),
    evidence: z.array(z.object({ conversation_id: z.uuid().nullable() }).passthrough()),
  })
  .passthrough();
const position = (row: Record<string, unknown>) =>
  candidatePosition.parse({ rank: row.cursor_rank, at: row.cursor_at, id: row.id });
/** Walk past private sources without an inaccessible first batch starving the queue.
 * A bounded scan can return a continuation with no visible rows; never infer absence. */
export async function loadMemoryCandidatePage(
  pool: Pool,
  org: string,
  contact: string,
  status: "pending" | "all",
  after: CandidatePosition | null,
  readable: (ids: string[]) => Promise<Set<string>>,
) {
  const visible: Array<{ row: Record<string, unknown>; position: CandidatePosition | null }> = [];
  let cursor = after;
  for (let batch = 0; batch < 5; batch++) {
    const result = await pool.query(
      `select c.*,c.updated_at::text revision_token,
      case when c.risk_level='high' then 0 else 1 end cursor_rank,
      to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
      array(select distinct conversation_id from ai_customer_memory_evidence where organization_id=c.organization_id and contact_id=c.contact_id and candidate_id=c.id and conversation_id is not null) source_conversation_ids,
      coalesce((select jsonb_agg(e) from (select id,conversation_id,message_id,excerpt,observed_at from ai_customer_memory_evidence
        where organization_id=c.organization_id and contact_id=c.contact_id and candidate_id=c.id order by observed_at desc,id limit 20) e),'[]'::jsonb) evidence,
      coalesce((select jsonb_agg(x) from (select id,memory_id,kind,created_at from ai_customer_memory_conflicts
        where organization_id=c.organization_id and contact_id=c.contact_id and candidate_id=c.id and status='open') x),'[]'::jsonb) conflicts
      from ai_customer_memory_candidates c where c.organization_id=$1 and c.contact_id=$2 and c.deleted_at is null and ($3='all' or c.status='pending')
      and ($4::int is null or (case when c.risk_level='high' then 0 else 1 end,c.created_at,c.id)>($4,$5::timestamptz,$6::uuid))
      order by (case when c.risk_level='high' then 0 else 1 end),c.created_at,c.id limit 100`,
      [org, contact, status, cursor?.rank ?? null, cursor?.at ?? null, cursor?.id ?? null],
    );
    const rows = result.rows.map((r) => view.parse(r));
    const sources = (r: z.infer<typeof view>) =>
      r.source_conversation_ids ??
      r.evidence.flatMap((e) => (e.conversation_id ? [e.conversation_id] : []));
    const allowed = await readable([...new Set(rows.flatMap(sources))]);
    for (const raw of rows) {
      const ids = sources(raw);
      if (raw.source_kind !== "explicit" && (!ids.length || !ids.every((id) => allowed.has(id))))
        continue;
      const { source_conversation_ids: _ids, cursor_at: _at, cursor_rank: _rank, ...row } = raw;
      const evidence = raw.evidence.filter(
        (e) => !e.conversation_id || allowed.has(e.conversation_id),
      );
      if (raw.source_kind !== "explicit" && !evidence.some((e) => e.conversation_id)) continue;
      visible.push({
        row: { ...row, evidence },
        position: rows.length === 100 || visible.length >= 49 ? position(raw) : null,
      });
      if (visible.length === 51)
        return {
          rows: visible.slice(0, 50).map((v) => v.row),
          cursor: visible[49]!.position!,
          has_more: true,
          scan_partial: false,
        };
    }
    if (rows.length < 100)
      return {
        rows: visible.map((v) => v.row),
        cursor: null,
        has_more: false,
        scan_partial: false,
      };
    cursor = position(rows.at(-1)!);
  }
  return { rows: visible.map((v) => v.row), cursor, has_more: true, scan_partial: true };
}
