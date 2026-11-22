import type { Pool } from "pg";
import { z } from "zod";
import { withMemoryContact, assertMemoryAuthority } from "./authority";
import { recordMemoryAudit } from "./audit";

export const memoryUsageQuery = z
  .object({
    context: z.enum(["workbench", "draft", "conversation"]),
    id: z.uuid(),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export type MemoryUsageQuery = z.infer<typeof memoryUsageQuery>;
const cursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() }).strict();
export const memoryCorrectionInput = z
  .object({
    usage_id: z.uuid(),
    reason: z.string().trim().min(1).max(1000),
    context: z.enum(["workbench", "draft", "conversation"]),
    id: z.uuid(),
  })
  .strict();
export interface MemoryUsageTarget {
  contactId: string;
  runIds: string[];
  draftId: string | null;
  conversationId: string | null;
  generationToken: string | null;
  managerOnly: boolean;
}
export async function resolveMemoryUsageTarget(
  pool: Pool,
  org: string,
  input: MemoryUsageQuery,
): Promise<MemoryUsageTarget> {
  let contact: string | undefined,
    runId: string | undefined,
    conversation: string | null = null,
    draft: string | null = null,
    token: string | null = null;
  if (input.context === "workbench") {
    const row = (
      await pool.query<{ id: string; contact_id: string | null }>(
        `select r.id,coalesce(nullif(r.scope->>'contactId',''),
    (select min(contact_id::text) from ai_customer_memory_recalls where organization_id=r.organization_id and run_id=r.id having count(distinct contact_id)=1),
    (select min(contact_id::text) from ai_customer_memory_usage where organization_id=r.organization_id and run_id=r.id having count(distinct contact_id)=1)) contact_id
    from ai_workbench_runs r where r.organization_id=$1 and r.id=$2`,
        [org, input.id],
      )
    ).rows[0];
    if (row?.contact_id) {
      contact = row.contact_id;
      runId = row.id;
    }
  } else if (input.context === "draft") {
    const row = (
      await pool.query<{
        id: string;
        contact_id: string;
        conversation_id: string;
        generation_token: string;
        workbench_run_id: string | null;
      }>(
        "select id,contact_id,conversation_id,generation_token,workbench_run_id from ai_reply_drafts where organization_id=$1 and id=$2",
        [org, input.id],
      )
    ).rows[0];
    if (row) {
      contact = row.contact_id;
      conversation = row.conversation_id;
      draft = row.id;
      token = row.generation_token;
      runId = row.workbench_run_id ?? undefined;
    }
  } else {
    const row = (
      await pool.query<{ contact_id: string }>(
        "select contact_id from conversations where organization_id=$1 and id=$2 and not is_group",
        [org, input.id],
      )
    ).rows[0];
    if (row) {
      contact = row.contact_id;
      conversation = input.id;
    }
  }
  if (
    !contact ||
    !z.uuid().safeParse(contact).success ||
    !(
      await pool.query(
        "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
        [org, contact],
      )
    ).rows.length
  )
    throw new Error("customer_memory_artifact_unavailable");
  const runIds = runId
    ? (
        await pool.query<{ id: string }>(
          "select id from ai_workbench_runs where organization_id=$1 and (id=$2 or parent_run_id=$2)",
          [org, runId],
        )
      ).rows.map((row) => row.id)
    : [];
  return {
    contactId: contact,
    runIds,
    draftId: draft,
    conversationId: conversation,
    generationToken: token,
    managerOnly: input.context === "workbench",
  };
}
export async function loadCustomerMemoryUsage(
  pool: Pool,
  org: string,
  target: MemoryUsageTarget,
  cursor?: string,
) {
  let before: { at: string; id: string } | null = null;
  if (cursor) {
    try {
      before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch {
      throw new Error("memory_cursor_invalid");
    }
  }
  const params = [
    org,
    target.contactId,
    target.runIds,
    target.draftId,
    target.conversationId,
    target.generationToken,
  ];
  const filter = `(r.run_id=any($3::uuid[]) or ($4::uuid is not null and r.draft_id=$4 and ($6::uuid is null or r.draft_generation_token is null or r.draft_generation_token=$6))
   or ($3::uuid[]='{}'::uuid[] and $4::uuid is null and r.conversation_id=$5))`;
  const recalls = await pool.query(
    `select r.id,r.status,r.provider_status,r.coverage,r.returned_count,r.business_coverage,r.purpose,r.call_outcome,r.injected_at,r.consumed_at
   from ai_customer_memory_recalls r where r.organization_id=$1 and r.contact_id=$2 and ${filter} order by r.consumed_at desc,r.id desc limit 21`,
    params,
  );
  const usage = await pool.query(
    `select u.id,u.recall_id,u.memory_id,u.memory_revision,u.policy_revision,u.memory_type,u.risk_level,u.locked,u.needs_review,u.confirmed_by,u.confirmed_at,
   u.used_at,to_char(u.used_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
   u.corrected_at,u.corrected_by,u.correction_reason,r.status recall_status,r.provider_status,r.coverage,r.call_outcome,
   case when m.deleted_at is null and m.content_hash=u.memory_revision then m.body else null end body,
   (m.deleted_at is not null) retired,(m.policy_revision<>u.policy_revision) current_version_changed,
   m.evidence_conversation_id,m.needs_review current_needs_review
   from ai_customer_memory_usage u join ai_customer_memory_recalls r on r.organization_id=u.organization_id and r.contact_id=u.contact_id and r.id=u.recall_id
   join ai_customer_memories m on m.organization_id=u.organization_id and m.contact_id=u.contact_id and m.id=u.memory_id
   where u.organization_id=$1 and u.contact_id=$2 and ${filter} and ($7::timestamptz is null or (u.used_at,u.id)<($7::timestamptz,$8::uuid))
   order by u.used_at desc,u.id desc limit 51`,
    [...params, before?.at ?? null, before?.id ?? null],
  );
  const rows = usage.rows.slice(0, 50),
    last = rows.at(-1);
  return {
    recalls: recalls.rows.slice(0, 20),
    usage: rows.map(({ cursor_at: _cursor, ...row }) => row),
    meta: {
      has_more: usage.rows.length > 50,
      recalls_has_more: recalls.rows.length > 20,
      cursor:
        usage.rows.length > 50 && last
          ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString("base64url")
          : null,
      absence_semantics: "not_recalled_does_not_mean_no_preference",
    },
  };
}
export async function correctCustomerMemoryUsage(
  pool: Pool,
  org: string,
  actor: string,
  raw: z.infer<typeof memoryCorrectionInput>,
  beforeWrite?: (conversationId: string | null) => Promise<void>,
) {
  const input = memoryCorrectionInput.parse(raw);
  const target = await resolveMemoryUsageTarget(pool, org, input);
  const result = await withMemoryContact(pool, org, target.contactId, async (db) => {
    await assertMemoryAuthority(
      db,
      org,
      target.contactId,
      actor,
      target.managerOnly ? "arbitrate" : "propose",
    );
    if (
      target.draftId &&
      !(
        await db.query(
          "select id from ai_reply_drafts where organization_id=$1 and contact_id=$2 and id=$3 and generation_token=$4 for share",
          [org, target.contactId, target.draftId, target.generationToken],
        )
      ).rows.length
    )
      throw new Error("customer_memory_draft_unavailable");
    const row = (
      await db.query<{
        memory_id: string;
        memory_revision: string;
        policy_revision: number;
        corrected_at: Date | null;
        conversation_id: string | null;
      }>(
        `select u.memory_id,u.memory_revision,u.policy_revision,u.corrected_at,r.conversation_id
   from ai_customer_memory_usage u join ai_customer_memory_recalls r on r.organization_id=u.organization_id and r.contact_id=u.contact_id and r.id=u.recall_id
   where u.organization_id=$1 and u.contact_id=$2 and u.id=$3 and (
     r.run_id=any($4::uuid[]) or (r.draft_id=$5::uuid and ($6::uuid is null or r.draft_generation_token is null or r.draft_generation_token=$6))
     or ($4::uuid[]='{}'::uuid[] and $5::uuid is null and r.conversation_id=$7)) for update of u`,
        [
          org,
          target.contactId,
          input.usage_id,
          target.runIds,
          target.draftId,
          target.generationToken,
          target.conversationId,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("customer_memory_usage_unavailable");
    if (
      target.conversationId &&
      !(
        await db.query(
          "select id from conversations where organization_id=$1 and contact_id=$2 and id=$3 for share",
          [org, target.contactId, target.conversationId],
        )
      ).rows.length
    )
      throw new Error("customer_memory_conversation_unavailable");
    await beforeWrite?.(target.conversationId);
    if (row.corrected_at) return { id: input.usage_id, deduped: true, memory_flagged: false };
    await db.query(
      "update ai_customer_memory_usage set corrected_at=now(),corrected_by=$3,correction_reason=$4 where organization_id=$1 and id=$2",
      [org, input.usage_id, actor, input.reason],
    );
    const marked = await db.query(
      `update ai_customer_memories set needs_review=true,review_reason='usage_correction',policy_revision=policy_revision+1,updated_at=now()
    where organization_id=$1 and contact_id=$2 and id=$3 and deleted_at is null and content_hash=$4 and policy_revision=$5 returning id`,
      [org, target.contactId, row.memory_id, row.memory_revision, row.policy_revision],
    );
    return { id: input.usage_id, deduped: false, memory_flagged: marked.rows.length > 0 };
  });
  if (!result.deduped)
    await recordMemoryAudit(pool, org, target.contactId, "ai.customer_memory_corrected", {
      usage_id: input.usage_id,
      memory_flagged: result.memory_flagged,
      actor_user_id: actor,
    });
  return result;
}
