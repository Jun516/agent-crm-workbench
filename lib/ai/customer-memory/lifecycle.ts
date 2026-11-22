import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { deleteCustomerMemory } from "@/lib/ai/integrations/mem0";
import { assertMemoryAuthority, withMemoryContact } from "./authority";
import { loadCustomerBusinessFacts } from "./business-facts";

const identity = {
  contact_id: z.string().uuid(),
  memory_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
};
const reason = z.string().trim().min(1).max(800);
export const memoryLifecycleInput = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("set_lock"), locked: z.boolean() }).strict(),
  z
    .object({
      ...identity,
      action: z.literal("review"),
      reason,
      review_due_at: z.iso.datetime({ offset: true }).nullable(),
    })
    .strict(),
  z.object({ ...identity, action: z.literal("retire"), reason }).strict(),
  z
    .object({
      ...identity,
      action: z.literal("resolve_conflict"),
      conflict_id: z.string().uuid(),
      resolution: z.enum(["keep_memory", "keep_other", "keep_both", "retire_memory"]),
      reason,
      other_expected_revision: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type MemoryLifecycleInput = z.infer<typeof memoryLifecycleInput>;
interface Row {
  id: string;
  policy_revision: number;
  locked: boolean;
  retention_policy: string;
  ttl_expires_at: Date | null;
  expired: boolean;
}
async function currentMemory(
  db: PoolClient,
  org: string,
  contact: string,
  id: string,
  revision: number,
) {
  const row = (
    await db.query<Row>(
      `select id,policy_revision,locked,retention_policy,ttl_expires_at,
      coalesce(ttl_expires_at<=now(),false) expired from ai_customer_memories
     where organization_id=$1 and contact_id=$2 and id=$3 and deleted_at is null for update`,
      [org, contact, id],
    )
  ).rows[0];
  if (!row) throw new Error("customer_memory_memory_unavailable");
  if (row.policy_revision !== revision) throw new Error("customer_memory_stale_revision");
  return row;
}
async function retire(
  db: PoolClient,
  org: string,
  contact: string,
  row: Row,
  actor: string,
  note: string,
) {
  if (row.locked) throw new Error("customer_memory_unlock_required");
  if (!(await deleteCustomerMemory(db, org, row.id)))
    throw new Error("customer_memory_stale_revision");
  await db.query(
    `update ai_customer_memory_conflicts set status='resolved',resolved_at=now(),resolved_by=$4,resolution=$5
      where organization_id=$1 and contact_id=$2 and (memory_id=$3 or other_memory_id=$3) and status='open'`,
    [org, contact, row.id, actor, `memory_retired:${note}`],
  );
}
async function hasConflicts(db: PoolClient, org: string, contact: string, id: string) {
  return Boolean(
    (
      await db.query(
        `select id from ai_customer_memory_conflicts where organization_id=$1 and contact_id=$2
      and (memory_id=$3 or other_memory_id=$3) and status='open' limit 1`,
        [org, contact, id],
      )
    ).rows.length,
  );
}
async function reviewed(
  db: PoolClient,
  org: string,
  contact: string,
  id: string,
  actor: string,
  note: string,
  due: string | null | undefined,
) {
  const unresolved = await hasConflicts(db, org, contact, id);
  await db.query(
    `update ai_customer_memories set needs_review=$4,review_reason=$5,confirmed_by=$6,confirmed_at=now(),
      review_due_at=case when $7 then $8::timestamptz else review_due_at end,
      policy_revision=policy_revision+1,updated_at=now() where organization_id=$1 and contact_id=$2 and id=$3`,
    [org, contact, id, unresolved, `human_review:${note}`, actor, due !== undefined, due ?? null],
  );
}

/** Human-only changes. A fresh tenant membership/ownership check fences transfer and revocation. */
export async function changeCustomerMemoryLifecycle(
  pool: Pool,
  org: string,
  actor: string,
  input: MemoryLifecycleInput,
) {
  const parsed = memoryLifecycleInput.parse(input);
  return withMemoryContact(pool, org, parsed.contact_id, async (db) => {
    await assertMemoryAuthority(
      db,
      org,
      parsed.contact_id,
      actor,
      parsed.action === "resolve_conflict" ? "arbitrate" : "confirm",
    );
    const row = await currentMemory(
      db,
      org,
      parsed.contact_id,
      parsed.memory_id,
      parsed.expected_revision,
    );
    if (parsed.action === "set_lock") {
      if (parsed.locked && (row.retention_policy !== "durable" || row.expired))
        throw new Error("memory_lock_requires_durable");
      await db.query(
        `update ai_customer_memories set locked=$4,policy_revision=policy_revision+1,updated_at=now()
          where organization_id=$1 and contact_id=$2 and id=$3`,
        [org, parsed.contact_id, row.id, parsed.locked],
      );
    } else if (parsed.action === "retire") {
      await retire(db, org, parsed.contact_id, row, actor, parsed.reason);
    } else if (parsed.action === "review") {
      if (row.expired) throw new Error("customer_memory_expired_requires_replacement");
      if (parsed.review_due_at && Date.parse(parsed.review_due_at) <= Date.now())
        throw new Error("memory_review_date_in_past");
      if (await hasConflicts(db, org, parsed.contact_id, row.id))
        throw new Error("customer_memory_conflict_requires_arbitration");
      await reviewed(
        db,
        org,
        parsed.contact_id,
        row.id,
        actor,
        parsed.reason,
        parsed.review_due_at,
      );
    } else {
      const conflict = (
        await db.query<{
          id: string;
          kind: string;
          memory_id: string;
          other_memory_id: string | null;
          business_lead_id: string | null;
          business_order_id: string | null;
          business_fingerprint: string | null;
        }>(
          `select * from ai_customer_memory_conflicts where organization_id=$1 and contact_id=$2 and id=$3
        and memory_id=$4 and status='open' for update`,
          [org, parsed.contact_id, parsed.conflict_id, row.id],
        )
      ).rows[0];
      if (!conflict) throw new Error("customer_memory_conflict_unavailable");
      if (conflict.kind === "l2_l1") throw new Error("customer_memory_use_candidate_decision");
      if (row.expired) throw new Error("customer_memory_expired_requires_replacement");
      let other: Row | undefined;
      if (conflict.kind === "l1_l1") {
        if (!conflict.other_memory_id || !parsed.other_expected_revision)
          throw new Error("customer_memory_other_revision_required");
        other = await currentMemory(
          db,
          org,
          parsed.contact_id,
          conflict.other_memory_id,
          parsed.other_expected_revision,
        );
        if (other.expired) throw new Error("customer_memory_expired_requires_replacement");
        if (parsed.resolution === "retire_memory")
          throw new Error("customer_memory_resolution_invalid");
      } else {
        if (!["keep_memory", "retire_memory"].includes(parsed.resolution))
          throw new Error("customer_memory_resolution_invalid");
        const facts = await loadCustomerBusinessFacts(db, org, parsed.contact_id, true);
        if (
          !facts.facts.some(
            (f) =>
              f.id === (conflict.business_lead_id ?? conflict.business_order_id) &&
              f.revision === conflict.business_fingerprint,
          )
        )
          throw new Error("customer_memory_business_fact_changed");
      }
      // Explicit unlock is a separate human gesture; resolution never unlocks implicitly.
      if (parsed.resolution === "keep_memory" && other)
        await retire(db, org, parsed.contact_id, other, actor, parsed.reason);
      if (parsed.resolution === "keep_other" || parsed.resolution === "retire_memory")
        await retire(db, org, parsed.contact_id, row, actor, parsed.reason);
      await db.query(
        `update ai_customer_memory_conflicts set status='resolved',resolution=$4,resolved_by=$5,resolved_at=now()
          where organization_id=$1 and contact_id=$2 and id=$3`,
        [org, parsed.contact_id, conflict.id, `${parsed.resolution}:${parsed.reason}`, actor],
      );
      if (!["keep_other", "retire_memory"].includes(parsed.resolution))
        await reviewed(db, org, parsed.contact_id, row.id, actor, parsed.reason, undefined);
      if (other && ["keep_other", "keep_both"].includes(parsed.resolution))
        await reviewed(db, org, parsed.contact_id, other.id, actor, parsed.reason, undefined);
    }
    return { id: row.id, action: parsed.action };
  });
}
