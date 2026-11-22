import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideCustomerMemory,
  proposeCustomerMemory,
  type ProposeMemoryInput,
} from "@/lib/ai/customer-memory/candidates";
import { readConfirmedCustomerMemory, saveCustomerMemory } from "@/lib/ai/integrations/mem0";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const org = randomUUID(),
  otherOrg = randomUUID(),
  contact = randomUUID(),
  foreignContact = randomUUID();
const owner = randomUUID(),
  colleague = randomUUID(),
  manager = randomUUID(),
  channel = randomUUID(),
  conversation = randomUUID(),
  message = randomUUID();
const make = (body: string, extra: Partial<ProposeMemoryInput> = {}): ProposeMemoryInput => ({
  contact_id: contact,
  request_key: randomUUID(),
  category: "communication_context",
  memory_type: "communication_preference",
  body,
  evidence: [],
  conflicts_with: [],
  ...extra,
});
const token = async (id: string) =>
  (
    await pool.query(
      "select updated_at::text t from ai_customer_memory_candidates where organization_id=$1 and id=$2",
      [org, id],
    )
  ).rows[0].t as string;
beforeAll(async () => {
  for (const id of [org, otherOrg])
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Memory candidates','Memory candidates')",
      [id],
    );
  for (const [id, role] of [
    [owner, "agent"],
    [colleague, "agent"],
    [manager, "manager"],
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
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Synthetic customer'),($3,$4,'Foreign customer')",
    [contact, org, foreignContact, otherOrg],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,assignee_kind,assigned_at)
    values($1,$2,$3,$4,$5,'user',now())`,
    [conversation, org, contact, channel, owner],
  );
  await pool.query(
    `insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,body)
    values($1,$2,$3,$4,$5,'text','inbound','Please use email. Never phone me in the evening.')`,
    [message, org, contact, conversation, channel],
  );
});
afterAll(() => pool.end());
describe("evidence-backed L2 and current human authority", () => {
  it("keeps automatic extraction in L2 and validates the exact inbound quote", async () => {
    await expect(
      proposeCustomerMemory(
        pool,
        org,
        make("Invented preference", {
          evidence: [{ message_id: message, excerpt: "I offer a discount" }],
        }),
        { kind: "conversation_close", actor: null, confidence: 0.9 },
      ),
    ).rejects.toThrow("evidence_unavailable");
    const c = await proposeCustomerMemory(
      pool,
      org,
      make("No evening calls", {
        memory_type: "constraint",
        evidence: [{ message_id: message, excerpt: "Never phone me in the evening." }],
      }),
      { kind: "conversation_close", actor: null, confidence: 0.9 },
    );
    expect(c.status).toBe("pending");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memories where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await readConfirmedCustomerMemory(pool, org, contact)).memories).toEqual([]);
    expect(
      (
        await pool.query("select excerpt from ai_customer_memory_evidence where candidate_id=$1", [
          c.id,
        ])
      ).rows[0].excerpt,
    ).toBe("Never phone me in the evening.");
    await expect(
      proposeCustomerMemory(pool, org, make("No source"), {
        kind: "checkpoint",
        actor: null,
        confidence: 0.9,
      }),
    ).rejects.toThrow("evidence_required");
  });
  it("lets colleagues propose but only owner/manager confirm, including rewrite", async () => {
    const c = await proposeCustomerMemory(pool, org, make("Brief messages preferred"), {
      kind: "explicit",
      actor: colleague,
    });
    await expect(
      decideCustomerMemory(pool, org, colleague, {
        action: "confirm",
        id: c.id,
        revision_token: await token(c.id),
      }),
    ).rejects.toThrow("owner_required");
    const confirmed = await decideCustomerMemory(pool, org, owner, {
      action: "confirm",
      id: c.id,
      revision_token: await token(c.id),
      body: "Prefers a short summary before details",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(
      (
        await pool.query("select body,confirmed_by from ai_customer_memories where id=$1", [
          confirmed.memory_id,
        ])
      ).rows[0],
    ).toMatchObject({ body: "Prefers a short summary before details", confirmed_by: owner });
    await expect(
      decideCustomerMemory(pool, org, owner, {
        action: "confirm",
        id: c.id,
        revision_token: c.revision_token!,
      }),
    ).rejects.toThrow("candidate_changed");
  });
  it("carries pending confirmation authority with the current assignment, not old ownership", async () => {
    const c = await proposeCustomerMemory(pool, org, make("Wants document links"), {
      kind: "explicit",
      actor: colleague,
    });
    await pool.query(
      "update conversations set assigned_to_user_id=$2,assigned_at=now() where organization_id=$1 and id=$3",
      [org, colleague, conversation],
    );
    try {
      await expect(
        decideCustomerMemory(pool, org, owner, {
          action: "confirm",
          id: c.id,
          revision_token: await token(c.id),
        }),
      ).rejects.toThrow("owner_required");
      expect(
        (
          await decideCustomerMemory(pool, org, colleague, {
            action: "confirm",
            id: c.id,
            revision_token: await token(c.id),
          })
        ).status,
      ).toBe("confirmed");
    } finally {
      await pool.query(
        "update conversations set assigned_to_user_id=$2,assigned_at=now() where organization_id=$1 and id=$3",
        [org, owner, conversation],
      );
    }
  });
  it("records rejection reasons, suppresses the same signal during the chosen cooldown, and dedupes pending suggestions", async () => {
    const input = make("Email is easier", {
      attribute_key: "communication.channel",
      attribute_value: "email",
    });
    const first = await proposeCustomerMemory(pool, org, input, { kind: "explicit", actor: owner });
    const duplicate = await proposeCustomerMemory(
      pool,
      org,
      { ...input, request_key: randomUUID(), body: "Email is preferred" },
      { kind: "explicit", actor: owner },
    );
    expect(duplicate.id).toBe(first.id);
    const reason = "Customer asked to revisit this later";
    await decideCustomerMemory(pool, org, owner, {
      action: "reject",
      id: first.id,
      revision_token: await token(first.id),
      reason,
      rejected_until: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(
      (
        await proposeCustomerMemory(
          pool,
          org,
          { ...input, request_key: randomUUID() },
          { kind: "explicit", actor: owner },
        )
      ).status,
    ).toBe("suppressed");
    expect(
      (
        await pool.query("select decision_reason from ai_customer_memory_candidates where id=$1", [
          first.id,
        ])
      ).rows[0].decision_reason,
    ).toBe(reason);
  });
  it("keeps contradictory candidates pending until a manager explicitly replaces an unlocked fact", async () => {
    const existing = await saveCustomerMemory(pool, org, manager, {
      contact_id: contact,
      request_key: randomUUID(),
      category: "preference",
      body: "Prefers email",
      confirmed: true,
      memory_type: "communication_preference",
      attribute_key: "channel.preference",
      attribute_value: "email",
      locked: true,
    });
    const c = await proposeCustomerMemory(
      pool,
      org,
      make("Prefers SMS", { attribute_key: "channel.preference", attribute_value: "sms" }),
      { kind: "explicit", actor: owner },
    );
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_conflicts where candidate_id=$1 and status='open'",
          [c.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      decideCustomerMemory(pool, org, owner, {
        action: "confirm",
        id: c.id,
        revision_token: await token(c.id),
        policy: { supersedes: existing.id },
      }),
    ).rejects.toThrow("manager_required");
    await expect(
      decideCustomerMemory(pool, org, manager, {
        action: "confirm",
        id: c.id,
        revision_token: await token(c.id),
        policy: { supersedes: existing.id },
      }),
    ).rejects.toThrow("unlock_required");
    await pool.query(
      "update ai_customer_memories set locked=false where organization_id=$1 and id=$2",
      [org, existing.id],
    );
    expect(
      (
        await decideCustomerMemory(pool, org, manager, {
          action: "confirm",
          id: c.id,
          revision_token: await token(c.id),
          policy: { supersedes: existing.id },
        })
      ).status,
    ).toBe("confirmed");
  });
  it("rejects cross-tenant evidence and source contact and cannot reuse a revoked membership", async () => {
    await expect(
      proposeCustomerMemory(
        pool,
        otherOrg,
        make("Foreign", {
          contact_id: foreignContact,
          evidence: [{ message_id: message, excerpt: "Please use email." }],
        }),
        { kind: "conversation_close", actor: null, confidence: 0.9 },
      ),
    ).rejects.toThrow("evidence_unavailable");
    await pool.query("delete from user_organizations where user_id=$1 and organization_id=$2", [
      colleague,
      org,
    ]);
    await expect(
      proposeCustomerMemory(pool, org, make("Revoked proposal"), {
        kind: "explicit",
        actor: colleague,
      }),
    ).rejects.toThrow("forbidden");
  });
  it("merges only an explicit same-contact compatible pair and keeps both evidence excerpts", async () => {
    const a = await proposeCustomerMemory(pool, org, make("Friendly wording preferred"), {
      kind: "explicit",
      actor: owner,
    });
    const b = await proposeCustomerMemory(pool, org, make("Use a friendly tone"), {
      kind: "explicit",
      actor: owner,
    });
    expect(
      (
        await decideCustomerMemory(pool, org, owner, {
          action: "merge",
          id: a.id,
          target_id: b.id,
          revision_token: await token(a.id),
        })
      ).status,
    ).toBe("merged");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_evidence where candidate_id=$1",
          [b.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query("select merged_into from ai_customer_memory_candidates where id=$1", [
          a.id,
        ])
      ).rows[0].merged_into,
    ).toBe(b.id);
  });
  it("does not confirm a candidate after the version shown to the owner has changed", async () => {
    const c = await proposeCustomerMemory(pool, org, make("Send reports monthly"), {
      kind: "explicit",
      actor: owner,
    });
    const before = await token(c.id);
    await pool.query(
      "update ai_customer_memory_candidates set updated_at=updated_at+interval '1 second' where id=$1",
      [c.id],
    );
    await expect(
      decideCustomerMemory(pool, org, owner, {
        action: "confirm",
        id: c.id,
        revision_token: before,
      }),
    ).rejects.toThrow("candidate_changed");
    expect(
      (await pool.query("select status from ai_customer_memory_candidates where id=$1", [c.id]))
        .rows[0].status,
    ).toBe("pending");
  });
});
