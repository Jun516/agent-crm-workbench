import type { Pool, PoolClient } from "pg";
import { ROLE_RANK, type Role } from "@/lib/auth/types";

export type MemoryAuthority = "propose" | "confirm" | "arbitrate";

/** Caller holds the contact lock. Membership and assignment locks fence transfers/revocation. */
export async function assertMemoryAuthority(
  db: PoolClient,
  org: string,
  contact: string,
  actor: string,
  action: MemoryAuthority,
) {
  const membership = await db.query<{ role: Role }>(
    "select role from user_organizations where organization_id=$1 and user_id=$2 and accepted_at is not null and revoked_at is null for share",
    [org, actor],
  );
  const role = membership.rows[0]?.role;
  if (!role || ROLE_RANK[role] < ROLE_RANK.agent) throw new Error("customer_memory_forbidden");
  if (action === "propose" || ROLE_RANK[role] >= ROLE_RANK.manager) return;
  if (action === "arbitrate") throw new Error("customer_memory_manager_required");
  const reception = await db.query<{ assigned_to_user_id: string | null }>(
    `select assigned_to_user_id from conversations where organization_id=$1 and contact_id=$2 and not is_group
     order by assigned_at desc nulls last,updated_at desc,id limit 1 for share`,
    [org, contact],
  );
  const lead = await db.query(
    "select id from crm_leads where organization_id=$1 and contact_id=$2 and owner_user_id=$3 and owner_kind='user' and status='open' for share",
    [org, contact, actor],
  );
  if (reception.rows[0]?.assigned_to_user_id !== actor && !lead.rows.length)
    throw new Error("customer_memory_owner_required");
}

export async function withMemoryContact<T>(
  pool: Pool,
  org: string,
  contact: string,
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const current = await db.query(
      "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null for update",
      [org, contact],
    );
    if (!current.rows.length) throw new Error("customer_memory_contact_unavailable");
    const result = await work(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function customerMemoryCapabilities(
  pool: Pool,
  org: string,
  contact: string,
  actor: string,
) {
  return withMemoryContact(pool, org, contact, async (db) => {
    await assertMemoryAuthority(db, org, contact, actor, "propose");
    let canConfirm = false,
      canArbitrate = false;
    try {
      await assertMemoryAuthority(db, org, contact, actor, "confirm");
      canConfirm = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "customer_memory_owner_required")
        throw error;
    }
    try {
      await assertMemoryAuthority(db, org, contact, actor, "arbitrate");
      canArbitrate = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "customer_memory_manager_required")
        throw error;
    }
    return { can_confirm: canConfirm, can_arbitrate: canArbitrate };
  });
}
