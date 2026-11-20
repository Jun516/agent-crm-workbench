import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfirmedCustomerMemory, saveCustomerMemory } from "@/lib/ai/integrations/mem0";
import { proposeCustomerMemory } from "@/lib/ai/customer-memory/candidates";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Run only via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const orgs = [randomUUID(), randomUUID()];
const users = [randomUUID(), randomUUID()];
const contacts = [randomUUID(), randomUUID()];
const memories = [randomUUID(), randomUUID()];
const candidates = [randomUUID(), randomUUID()];
const runs = [randomUUID(), randomUUID()];
const serviceTables = [
  "ai_customer_memory_candidates",
  "ai_customer_memory_evidence",
  "ai_customer_memory_conflicts",
  "ai_customer_memory_usage",
];
beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [
      users[i],
      `${users[i]}@memory.test.invalid`,
    ]);
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Memory','Memory')",
      [orgs[i]],
    );
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
      [users[i], orgs[i]],
    );
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Synthetic customer')",
      [contacts[i], orgs[i]],
    );
    await pool.query(
      `insert into ai_customer_memories(id,organization_id,contact_id,request_key,subject_key,category,body,content_hash,attribute_key,attribute_value)
      values($1,$2,$3,$1,repeat('a',64),'preference','Private preference',repeat('b',64),'communication.channel','email')`,
      [memories[i], orgs[i], contacts[i]],
    );
    const agent = randomUUID();
    await pool.query(
      "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Memory fixture','Read only')",
      [agent, orgs[i]],
    );
    await pool.query(
      "insert into ai_workbench_runs(id,organization_id,agent_id,task,mode) values($1,$2,$3,'Memory fixture','inspect')",
      [runs[i], orgs[i], agent],
    );
    await pool.query(
      `insert into ai_customer_memory_candidates(id,organization_id,contact_id,request_key,category,memory_type,body,risk_level,normalized_hash,source_kind)
      values($1,$2,$3,$1,'preference','communication_preference','Candidate private preference','medium',repeat('c',64),'explicit')`,
      [candidates[i], orgs[i], contacts[i]],
    );
    await pool.query(
      `insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,excerpt,observed_at)
      values($1,$2,$3,'Private explicit instruction',now())`,
      [orgs[i], contacts[i], candidates[i]],
    );
    await pool.query(
      `insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,candidate_id,conflict_key,kind)
      values($1,$2,$3,$4,'channel-conflict','l2_l1')`,
      [orgs[i], contacts[i], memories[i], candidates[i]],
    );
    await pool.query(
      `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,memory_id,memory_revision,policy_revision,correction_reason)
      values($1,$2,$3,$4,repeat('b',64),1,'Private correction')`,
      [orgs[i], contacts[i], runs[i], memories[i]],
    );
  }
});
afterAll(() => pool.end());

async function asBrowser(user: string | null, table: string) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: user ? "authenticated" : "anon", aal: "aal1" }),
    ]);
    return await c.query(`select * from public.${table}`);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

describe("customer-memory lifecycle on the actual self-host baseline", () => {
  it.each(serviceTables)(
    "%s has positive server rows and denies both tenant browsers and anon",
    async (table) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local role service_role");
        expect((await c.query(`select count(*)::int n from ${table}`)).rows[0].n).toBe(2);
      } finally {
        await c.query("rollback");
        c.release();
      }
      for (const user of [...users, null])
        await expect(asBrowser(user, table)).rejects.toMatchObject({ code: "42501" });
    },
  );

  it("enforces tenant AND contact lineage for hypotheses and evidence", async () => {
    await expect(
      pool.query(
        `insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,excerpt,observed_at)
      values($1,$2,$3,'Foreign evidence',now())`,
        [orgs[0], contacts[0], candidates[1]],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const sibling = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Sibling')",
      [sibling, orgs[0]],
    );
    await expect(
      pool.query(
        `update ai_customer_memory_candidates set confirmed_memory_id=$1,status='confirmed' where id=$2`,
        [memories[0], candidates[1]],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        `insert into ai_customer_memories(organization_id,contact_id,request_key,subject_key,category,body,content_hash,supersedes)
      values($1,$2,gen_random_uuid(),repeat('a',64),'preference','Cross-contact replacement',repeat('d',64),$3)`,
        [orgs[0], sibling, memories[0]],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("checks TTL/lock consistency in SQL even if a caller bypasses TypeScript", async () => {
    await expect(
      pool.query(
        "update ai_customer_memories set memory_type='temporary_request',retention_policy='ephemeral' where id=$1",
        [memories[0]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "update ai_customer_memories set retention_policy='ephemeral',ttl_expires_at=now()+interval '1 day',locked=true where id=$1",
        [memories[0]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects canonical business namespaces through both L1 and L2 writers before persisting a competing fact", async () => {
    for (const key of ["orders.total_cents", "crm_leads.status", "contracts.payment_terms"]) {
      const requestKey = randomUUID();
      const input = {
        contact_id: contacts[0]!,
        request_key: requestKey,
        category: "preference" as const,
        memory_type: "commercial_preference" as const,
        body: "Copied business fact",
        attribute_key: key,
        attribute_value: "copied L0",
        confirmed: true as const,
      };
      await expect(saveCustomerMemory(pool, orgs[0]!, users[0]!, input)).rejects.toThrow(
        "memory_business_fact_forbidden",
      );
      const { confirmed: _confirmed, ...proposal } = input;
      await expect(
        proposeCustomerMemory(
          pool,
          orgs[0]!,
          { ...proposal, evidence: [], conflicts_with: [] },
          { kind: "explicit", actor: users[0]! },
        ),
      ).rejects.toThrow("memory_business_fact_forbidden");
      for (const table of ["ai_customer_memories", "ai_customer_memory_candidates"]) {
        expect(
          (
            await pool.query(
              `select id from ${table} where organization_id=$1 and request_key=$2`,
              [orgs[0], requestKey],
            )
          ).rows,
        ).toHaveLength(0);
      }
    }
  });
  it("saves a new policy idempotently and replaces only explicitly unlocked same-contact memory", async () => {
    const key = randomUUID();
    const input = {
      contact_id: contacts[0]!,
      request_key: key,
      category: "communication_context" as const,
      body: "Prefers brief messages",
      confirmed: true as const,
      memory_type: "communication_preference" as const,
      locked: true,
    };
    const saved = await saveCustomerMemory(pool, orgs[0]!, users[0]!, input);
    expect(await saveCustomerMemory(pool, orgs[0]!, users[0]!, input)).toEqual(saved);
    await expect(
      saveCustomerMemory(pool, orgs[0]!, users[0]!, { ...input, locked: false }),
    ).rejects.toThrow("idempotency_conflict");
    const replacement = {
      ...input,
      request_key: randomUUID(),
      body: "Prefers detailed messages",
      locked: false,
      supersedes: saved.id,
    };
    await expect(saveCustomerMemory(pool, orgs[0]!, users[0]!, replacement)).rejects.toThrow(
      "unlock_required",
    );
    await pool.query(
      "update ai_customer_memories set locked=false where id=$1 and organization_id=$2",
      [saved.id, orgs[0]],
    );
    const newer = await saveCustomerMemory(pool, orgs[0]!, users[0]!, replacement);
    expect(
      (await pool.query("select supersedes from ai_customer_memories where id=$1", [newer.id]))
        .rows[0].supersedes,
    ).toBe(saved.id);
    expect(
      (
        await pool.query(
          "select deleted_at is not null retired,body,sync_state from ai_customer_memories where id=$1",
          [saved.id],
        )
      ).rows[0],
    ).toMatchObject({ retired: true, body: "", sync_state: "deleted" });
    expect(await saveCustomerMemory(pool, orgs[0]!, users[0]!, replacement)).toEqual(newer);
  });

  it("filters expired L1, keeps valid locked constraints, and never selects candidate bodies", async () => {
    const ephemeral = await saveCustomerMemory(pool, orgs[0]!, users[0]!, {
      contact_id: contacts[0]!,
      request_key: randomUUID(),
      category: "preference",
      body: "This week only",
      confirmed: true,
      memory_type: "temporary_request",
      ttl_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second' where id=$1",
      [ephemeral.id],
    );
    await pool.query(
      "update ai_customer_memories set locked=true,memory_type='constraint' where id=$1",
      [memories[0]],
    );
    const recalled = await readConfirmedCustomerMemory(pool, orgs[0]!, contacts[0]!);
    expect(recalled.memories.map((m) => m.id)).toContain(memories[0]);
    expect(recalled.memories.map((m) => m.id)).not.toContain(ephemeral.id);
    expect(JSON.stringify(recalled)).not.toContain("Candidate private preference");
  });

  it("recalls an older unlocked task-relevant preference beyond fifty newer unrelated rows", async () => {
    const contact = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Task recall fixture')",
      [contact, orgs[0]],
    );
    const preferred = await saveCustomerMemory(pool, orgs[0]!, users[0]!, {
      contact_id: contact,
      request_key: randomUUID(),
      category: "preference",
      memory_type: "communication_preference",
      body: "请用电子邮件沟通，避免电话打断。",
      confirmed: true,
    });
    await pool.query(
      "update ai_customer_memories set created_at='2020-01-01T00:00:00Z' where organization_id=$1 and id=$2",
      [orgs[0], preferred.id],
    );
    await pool.query(
      `insert into ai_customer_memories(organization_id,contact_id,request_key,subject_key,category,body,content_hash,memory_type,risk_level)
      select $1,$2,gen_random_uuid(),repeat('a',64),'preference','Synthetic color preference '||n,repeat('b',64),'communication_preference','medium' from generate_series(1,65) n`,
      [orgs[0], contact],
    );
    const result = await readConfirmedCustomerMemory(
      pool,
      orgs[0]!,
      contact,
      "请用电子邮件拟一封跟进消息",
    );
    expect(result.memories.map((m) => m.id)).toContain(preferred.id);
    expect(result.memories.find((m) => m.id === preferred.id)).toMatchObject({
      locked: false,
      body: "请用电子邮件沟通，避免电话打断。",
    });
    expect(result.coverage).toBe("partial");
  });

  it("redacts pending AND rejected hypotheses/evidence without losing remote cleanup receipts or a neighbor", async () => {
    await pool.query(
      "update ai_customer_memory_candidates set status='rejected',decision_reason='Private refusal',decided_at=now(),rejected_until=now()+interval '7 days' where id=$1",
      [candidates[0]],
    );
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [
      orgs[0],
      contacts[0],
    ]);
    expect(
      (
        await pool.query(
          "select body,attribute_value,decision_reason,deleted_at is not null redacted from ai_customer_memory_candidates where id=$1",
          [candidates[0]],
        )
      ).rows[0],
    ).toMatchObject({ body: "", attribute_value: null, decision_reason: null, redacted: true });
    expect(
      (
        await pool.query("select excerpt from ai_customer_memory_evidence where candidate_id=$1", [
          candidates[0],
        ])
      ).rows[0].excerpt,
    ).toBe("");
    expect(
      (
        await pool.query("select correction_reason from ai_customer_memory_usage where run_id=$1", [
          runs[0],
        ])
      ).rows[0].correction_reason,
    ).toBeNull();
    expect(
      (await pool.query("select body from ai_customer_memories where id=$1", [memories[0]])).rows[0]
        .body,
    ).toBe("");
    expect(
      (
        await pool.query("select body from ai_customer_memory_candidates where id=$1", [
          candidates[1],
        ])
      ).rows[0].body,
    ).toBe("Candidate private preference");
  });
});
