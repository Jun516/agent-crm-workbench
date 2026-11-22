import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  changeCustomerMemoryLifecycle,
  type MemoryLifecycleInput,
} from "@/lib/ai/customer-memory/lifecycle";
import { loadCustomerBusinessFacts } from "@/lib/ai/customer-memory/business-facts";
import { saveCustomerMemory, readConfirmedCustomerMemory } from "@/lib/ai/integrations/mem0";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
let org: string,
  contact: string,
  owner: string,
  manager: string,
  colleague: string,
  conversation: string;
beforeEach(async () => {
  org = randomUUID();
  contact = randomUUID();
  owner = randomUUID();
  manager = randomUUID();
  colleague = randomUUID();
  conversation = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Human memory','Human memory')",
    [org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Synthetic customer')",
    [contact, org],
  );
  for (const [id, role] of [
    [owner, "agent"],
    [manager, "manager"],
    [colleague, "agent"],
  ]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${id}@memory.test.invalid`,
    ]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [id, org, role],
    );
  }
  const channel = randomUUID();
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,assignee_kind,assigned_at) values($1,$2,$3,$4,$5,'user',now())",
    [conversation, org, contact, channel, owner],
  );
});
afterAll(() => pool.end());
async function memory(extra: Record<string, unknown> = {}) {
  return saveCustomerMemory(pool, org, owner, {
    contact_id: contact,
    request_key: randomUUID(),
    category: "preference",
    body: "Prefers email",
    confirmed: true,
    ...extra,
  });
}
const change = (
  id: string,
  extra: Omit<MemoryLifecycleInput, "contact_id" | "memory_id" | "expected_revision"> &
    Record<string, unknown>,
  actor = owner,
  rev = 1,
) =>
  changeCustomerMemoryLifecycle(pool, org, actor, {
    contact_id: contact,
    memory_id: id,
    expected_revision: rev,
    ...extra,
  } as MemoryLifecycleInput);
const get = async (id: string) =>
  (await pool.query("select * from ai_customer_memories where id=$1", [id])).rows[0];
async function pair(a: string, b: string) {
  return (
    await pool.query(
      "insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,other_memory_id,kind,conflict_key) values($1,$2,$3,$4,'l1_l1',$5) returning id",
      [org, contact, a, b, randomUUID()],
    )
  ).rows[0].id as string;
}
describe("human lifecycle with current authority and explicit revisions", () => {
  it("requires a separate unlock before retiring and clears sensitive structured content while preserving cleanup receipts", async () => {
    const m = await memory({
      locked: true,
      attribute_key: "communication.channel",
      attribute_value: "email",
    });
    await pool.query(
      "update ai_customer_memories set write_outcome='unknown',sync_state='reconcile' where id=$1",
      [m.id],
    );
    await expect(change(m.id, { action: "retire", reason: "obsolete" })).rejects.toThrow(
      "unlock_required",
    );
    await change(m.id, { action: "set_lock", locked: false });
    await expect(change(m.id, { action: "retire", reason: "obsolete" })).rejects.toThrow(
      "stale_revision",
    );
    await change(m.id, { action: "retire", reason: "obsolete" }, owner, 2);
    const row = await get(m.id);
    expect(row).toMatchObject({
      body: "",
      attribute_key: null,
      attribute_value: null,
      review_reason: null,
      write_outcome: "unknown",
      remote_deleted_at: null,
      sync_state: "deleted",
      policy_revision: 3,
    });
    expect(row.deleted_at).not.toBeNull();
    expect((await readConfirmedCustomerMemory(pool, org, contact)).memories).toEqual([]);
  });
  it("does not lock ephemeral facts or revive expired facts through review", async () => {
    const m = await memory({
      memory_type: "temporary_request",
      ttl_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });
    await expect(change(m.id, { action: "set_lock", locked: true })).rejects.toThrow(
      "lock_requires_durable",
    );
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second' where id=$1",
      [m.id],
    );
    await expect(
      change(m.id, { action: "review", reason: "looks okay", review_due_at: null }),
    ).rejects.toThrow("expired_requires_replacement");
  });
  it("checks current ownership, soft revocation, and tenant isolation rather than trusting route-time membership", async () => {
    const m = await memory();
    await expect(change(m.id, { action: "set_lock", locked: true }, colleague)).rejects.toThrow(
      "owner_required",
    );
    await pool.query(
      "update conversations set assigned_to_user_id=$2,assigned_at=now() where id=$1",
      [conversation, colleague],
    );
    await expect(change(m.id, { action: "set_lock", locked: true })).rejects.toThrow(
      "owner_required",
    );
    await change(m.id, { action: "set_lock", locked: true }, colleague);
    await pool.query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [org, colleague],
    );
    await expect(change(m.id, { action: "set_lock", locked: false }, colleague, 2)).rejects.toThrow(
      "forbidden",
    );
    await expect(
      changeCustomerMemoryLifecycle(pool, randomUUID(), manager, {
        contact_id: contact,
        memory_id: m.id,
        expected_revision: 2,
        action: "set_lock",
        locked: false,
      }),
    ).rejects.toThrow("contact_unavailable");
  });
  it("records the latest human reviewer and date and refuses to dismiss unresolved conflicts through ordinary review", async () => {
    const m = await memory();
    await pool.query(
      "update ai_customer_memories set needs_review=true,review_reason='review_due' where id=$1",
      [m.id],
    );
    await change(m.id, {
      action: "review",
      reason: "Customer reconfirmed email in reception",
      review_due_at: "2099-01-01T00:00:00Z",
    });
    expect(await get(m.id)).toMatchObject({
      needs_review: false,
      confirmed_by: owner,
      policy_revision: 2,
      review_reason: "human_review:Customer reconfirmed email in reception",
    });
    const other = await memory({ body: "Prefers phone" });
    await pair(m.id, other.id);
    await expect(
      change(
        m.id,
        { action: "review", reason: "ignore contradiction", review_due_at: null },
        owner,
        2,
      ),
    ).rejects.toThrow("conflict_requires_arbitration");
  });
  it("requires manager arbitration and explicit unlock, then retires only the selected opposite fact", async () => {
    const a = await memory(),
      b = await memory({ body: "Prefers phone", locked: true });
    const conflict = await pair(a.id, b.id);
    const action = {
      action: "resolve_conflict" as const,
      conflict_id: conflict,
      resolution: "keep_memory" as const,
      other_expected_revision: 1,
      reason: "Email preference reconfirmed",
    };
    await expect(change(a.id, action)).rejects.toThrow("manager_required");
    await expect(change(a.id, action, manager)).rejects.toThrow("unlock_required");
    expect((await get(a.id)).policy_revision).toBe(1);
    await change(b.id, { action: "set_lock", locked: false }, manager);
    await change(a.id, { ...action, other_expected_revision: 2 }, manager);
    expect((await get(a.id)).deleted_at).toBeNull();
    expect((await get(b.id)).deleted_at).not.toBeNull();
    expect(
      (
        await pool.query(
          "select status,resolved_by from ai_customer_memory_conflicts where id=$1",
          [conflict],
        )
      ).rows[0],
    ).toEqual({ status: "resolved", resolved_by: manager });
  });
  it("preserves both locked facts only with explicit manager context, exposed in recall", async () => {
    const a = await memory({ locked: true }),
      b = await memory({ body: "Use phone for urgent matters", locked: true });
    const conflict = await pair(a.id, b.id);
    await change(
      a.id,
      {
        action: "resolve_conflict",
        conflict_id: conflict,
        resolution: "keep_both",
        other_expected_revision: 1,
        reason: "Email for normal requests; phone only for urgent requests",
      },
      manager,
    );
    const recalled = await readConfirmedCustomerMemory(pool, org, contact);
    expect(recalled.memories).toHaveLength(2);
    for (const m of recalled.memories)
      expect(m).toMatchObject({
        locked: true,
        needs_review: false,
        review_note: "Email for normal requests; phone only for urgent requests",
      });
  });
  it("refuses stale L0 arbitration and never edits business facts", async () => {
    const m = await memory();
    const order = (
      await pool.query(
        "insert into orders(organization_id,contact_id,external_id,external_provider,status,total_cents,ordered_at,payment_method) values($1,$2,'synthetic','shopify','paid',25000,now(),'wire') returning id",
        [org, contact],
      )
    ).rows[0].id;
    const fact = (await loadCustomerBusinessFacts(pool, org, contact)).facts.find(
      (f) => f.id === order,
    )!;
    const conflict = (
      await pool.query(
        "insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,business_order_id,business_fingerprint,business_field,kind,conflict_key) values($1,$2,$3,$4,$5,'payment_method','l0_l1','order') returning id",
        [org, contact, m.id, order, fact.revision],
      )
    ).rows[0].id;
    await pool.query("update orders set payment_method='card' where id=$1", [order]);
    await expect(
      change(
        m.id,
        {
          action: "resolve_conflict",
          conflict_id: conflict,
          resolution: "keep_memory",
          reason: "still applicable elsewhere",
        },
        manager,
      ),
    ).rejects.toThrow("business_fact_changed");
    expect(
      (await pool.query("select payment_method from orders where id=$1", [order])).rows[0]
        .payment_method,
    ).toBe("card");
  });
});
