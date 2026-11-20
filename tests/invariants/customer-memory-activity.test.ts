import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadCustomerMemoryActivity,
  retryCustomerMemoryActivity,
  type MemoryActivityAccess,
} from "@/lib/ai/customer-memory/activity";
import { claimJobs, completeJob } from "@/lib/agent-engine/queue/queue";
import { runCustomerMemoryExtraction } from "@/lib/ai/customer-memory/extraction";
import type { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
let org: string, actor: string, contact: string, conv: string, colleague: string;
const all: MemoryActivityAccess = {
  conversations: async (ids) => new Set(ids),
  runs: async (ids) => new Set(ids),
};
beforeEach(async () => {
  org = randomUUID();
  actor = randomUUID();
  contact = randomUUID();
  conv = randomUUID();
  colleague = randomUUID();
  const channel = randomUUID();
  await pool.query(
    "insert into auth.users(id,email) values($1::uuid,$1::text||'@activity.test.invalid'),($2::uuid,$2::text||'@activity.test.invalid')",
    [actor, colleague],
  );
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Activity','Activity')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$3,'manager',now()),($2,$3,'agent',now())",
    [actor, colleague, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Activity subject')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,assignee_kind,assigned_at) values($1,$2,$3,$4,$5,'user',now())",
    [conv, org, contact, channel, actor],
  );
});
afterAll(() => pool.end());
const source = () => ({
  contact_id: contact,
  source_kind: "conversation_close",
  conversation_id: conv,
  service_revision: 1,
  until_at: "2026-11-12T12:00:00.123456Z",
  source_run_id: null,
  run_after: "2026-11-12T12:00:00Z",
});
async function seed(
  kind = "customer_memory_extract",
  status = "done",
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status,payload,last_error) values($1,$2,$3,$4,$5,$6,'PRIVATE_ERROR_CANARY')",
    [
      id,
      org,
      contact,
      kind,
      status,
      {
        source: source(),
        memory_result: { status: "unavailable", reason: "model_not_configured" },
        private_canary: "PRIVATE_JOB_CANARY",
        ...extra,
      },
    ],
  );
  return id;
}
const page = (
  access = all,
  after: Parameters<typeof loadCustomerMemoryActivity>[4] = null,
  who = actor,
) => loadCustomerMemoryActivity(pool, org, who, contact, after, access);
describe("body-free background memory status and current-authority retry", () => {
  it("lets the real queue claim a retried extraction and produces only an evidence-backed L2 candidate", async () => {
    const message = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,body,service_revision,created_at)
      select $1,$2,$3,id,channel_session_id,'text','inbound','Please use email.',1,'2026-11-12T11:00:00Z' from conversations where organization_id=$2 and id=$4`,
      [message, org, contact, conv],
    );
    const id = await seed(),
      view = (await page()).rows[0]!;
    await retryCustomerMemoryActivity(
      pool,
      org,
      actor,
      { contact_id: contact, job_id: id, revision: view.revision, request_key: randomUUID() },
      all,
    );
    await pool.query("update job_queue set priority=-30000 where id=$1", [id]);
    const worker = "activity-claim-fixture",
      claimed = (await claimJobs(pool, { workerId: worker, maxConcurrency: 10, batchSize: 1 }))[0]!;
    expect(claimed.id).toBe(id);
    const call: typeof runModelCall = async (_pool, _config, input) => {
      const material = JSON.parse(String(input.messages[0]!.content));
      expect(material.customerMessages.map((m: { id: string }) => m.id)).toContain(message);
      await input.tools!.submit_customer_memory_review!.execute!(
        {
          candidates: [
            {
              category: "communication_context",
              memory_type: "communication_preference",
              body: "Prefers email",
              confidence: 0.9,
              evidence: [{ message_id: message, excerpt: "Please use email." }],
              conflicts_with: [],
            },
          ],
          conflicts: [],
          memory_conflicts: [],
        },
        { toolCallId: "activity-fixture", messages: [], context: {} },
      );
      return {} as Awaited<ReturnType<typeof runModelCall>>;
    };
    await runCustomerMemoryExtraction(pool, {}, claimed, worker, { callModel: call });
    await completeJob(pool, id, worker, undefined, claimed.claim_acquired_at);
    expect((await page()).rows[0]).toMatchObject({
      id,
      state: "completed",
      retryable: false,
      candidates: 1,
    });
    expect(
      (
        await pool.query(
          "select status from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ status: "pending" }]);
    expect(
      (
        await pool.query(
          "select excerpt from ai_customer_memory_evidence where organization_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ excerpt: "Please use email." }]);
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memories where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("shows unavailable instead of successful emptiness and requeues the same bounded source idempotently", async () => {
    const id = await seed(),
      view = (await page()).rows[0]!;
    expect(view).toMatchObject({
      id,
      state: "unavailable",
      candidates: null,
      conflicts: null,
      retryable: true,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /PRIVATE_|source_run_id|conversation_id|until_at|payload|last_error/,
    );
    const input = {
      contact_id: contact,
      job_id: id,
      revision: view.revision,
      request_key: randomUUID(),
    };
    expect(await retryCustomerMemoryActivity(pool, org, actor, input, all)).toMatchObject({
      status: "pending",
      deduped: false,
    });
    expect(await retryCustomerMemoryActivity(pool, org, actor, input, all)).toMatchObject({
      status: "pending",
      deduped: true,
    });
    const row = (
      await pool.query("select status,attempts,payload,last_error from job_queue where id=$1", [id])
    ).rows[0];
    expect(row).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect(row.payload.source).toEqual(source());
    expect(row.payload.manual_retry).toMatchObject({
      request_key: input.request_key,
      actor_user_id: actor,
      count: 1,
    });
    expect(
      (await pool.query("select count(*)::int n from job_queue where organization_id=$1", [org]))
        .rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memories where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("rejects a stale revision, an active run and unrelated job kinds", async () => {
    const id = await seed(),
      view = (await page()).rows[0]!;
    const input = {
      contact_id: contact,
      job_id: id,
      revision: view.revision,
      request_key: randomUUID(),
    };
    await pool.query("update job_queue set attempts=attempts+1 where id=$1", [id]);
    await expect(retryCustomerMemoryActivity(pool, org, actor, input, all)).rejects.toThrow(
      "customer_memory_job_stale",
    );
    await pool.query(
      "update job_queue set status='running',locked_by='fixture',locked_at=now() where id=$1",
      [id],
    );
    const current = (await page()).rows[0]!;
    await expect(
      retryCustomerMemoryActivity(pool, org, actor, { ...input, revision: current.revision }, all),
    ).rejects.toThrow("customer_memory_job_not_retryable");
    await pool.query("update job_queue set status='done' where id=$1", [id]);
    const other = await seed("inbound_turn");
    await expect(
      retryCustomerMemoryActivity(pool, org, actor, { ...input, job_id: other }, all),
    ).rejects.toThrow("customer_memory_job_unavailable");
  });
  it("retries failed nightly maintenance but refuses successful completed work", async () => {
    const id = await seed("customer_memory_consolidate", "dead", {
      source: { contact_id: contact, run_after: "2026-11-12T12:00:00Z" },
    });
    const view = (await page()).rows[0]!;
    expect(view).toMatchObject({ source_kind: "nightly", state: "failed", retryable: true });
    await retryCustomerMemoryActivity(
      pool,
      org,
      actor,
      { contact_id: contact, job_id: id, revision: view.revision, request_key: randomUUID() },
      all,
    );
    await pool.query(
      "update job_queue set status='done',payload=jsonb_set(payload,'{memory_result}','{\"status\":\"completed\"}'::jsonb) where id=$1",
      [id],
    );
    const done = (await page()).rows[0]!;
    expect(done.retryable).toBe(false);
    await expect(
      retryCustomerMemoryActivity(
        pool,
        org,
        actor,
        { contact_id: contact, job_id: id, revision: done.revision, request_key: randomUUID() },
        all,
      ),
    ).rejects.toThrow("customer_memory_job_not_retryable");
  });
  it("checks present ownership and soft membership revocation, including idempotent replays", async () => {
    const id = await seed(),
      view = (await page()).rows[0]!;
    const input = {
      contact_id: contact,
      job_id: id,
      revision: view.revision,
      request_key: randomUUID(),
    };
    await expect(retryCustomerMemoryActivity(pool, org, colleague, input, all)).rejects.toThrow(
      "customer_memory_owner_required",
    );
    expect((await page(all, null, colleague)).can_retry).toBe(false);
    await pool.query(
      "update user_organizations set role='agent' where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    await retryCustomerMemoryActivity(pool, org, actor, input, all);
    await pool.query(
      "update conversations set assigned_to_user_id=$3,assigned_at=now() where organization_id=$1 and id=$2",
      [org, conv, colleague],
    );
    await expect(retryCustomerMemoryActivity(pool, org, actor, input, all)).rejects.toThrow(
      "customer_memory_owner_required",
    );
    expect((await page()).can_retry).toBe(false);
    expect((await page(all, null, colleague)).can_retry).toBe(true);
    await pool.query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [org, colleague],
    );
    await expect(page(all, null, colleague)).rejects.toThrow("customer_memory_forbidden");
    await expect(retryCustomerMemoryActivity(pool, org, colleague, input, all)).rejects.toThrow(
      "customer_memory_forbidden",
    );
  });
  it("hides private conversation jobs and denies retry without source access", async () => {
    const id = await seed(),
      view = (await page()).rows[0]!;
    const privateAccess = { ...all, conversations: async () => new Set<string>() };
    expect((await page(privateAccess)).rows).toEqual([]);
    await expect(
      retryCustomerMemoryActivity(
        pool,
        org,
        actor,
        { contact_id: contact, job_id: id, revision: view.revision, request_key: randomUUID() },
        privateAccess,
      ),
    ).rejects.toThrow("customer_memory_source_unavailable");
    expect(
      (await pool.query("select status from job_queue where id=$1", [id])).rows[0].status,
    ).toBe("done");
  });
  it("refuses a conversation from another contact even if the access callback would allow it", async () => {
    const foreign = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Foreign subject')",
      [foreign, org],
    );
    const id = await seed();
    await pool.query(
      "update job_queue set payload=jsonb_set(payload,'{source,contact_id}',to_jsonb($2::text)) where id=$1",
      [id, foreign],
    );
    expect((await page()).rows).toEqual([]);
    await pool.query(
      "update job_queue set payload=jsonb_set(payload,'{source,contact_id}',to_jsonb($2::text)) where id=$1",
      [id, contact],
    );
    await pool.query("update conversations set contact_id=$3 where organization_id=$1 and id=$2", [
      org,
      conv,
      foreign,
    ]);
    expect(
      (await page({ conversations: async () => new Set([conv]), runs: all.runs })).rows,
    ).toEqual([]);
  });
  it("checks run-source RLS and contact binding independently of callback permissions", async () => {
    const agent = randomUUID(),
      run = randomUUID();
    await pool.query(
      "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Activity fixture','Synthetic')",
      [agent, org],
    );
    await pool.query(
      "insert into ai_workbench_runs(id,organization_id,agent_id,task,mode,scope,status) values($1,$2,$3,'Activity fixture','inspect',$4,'completed')",
      [run, org, agent, { contactId: contact }],
    );
    const id = await seed("customer_memory_extract", "done", {
      source: {
        ...source(),
        source_kind: "workbench_complete",
        conversation_id: null,
        service_revision: null,
        source_run_id: run,
      },
    });
    const view = (await page()).rows[0]!;
    expect(view.id).toBe(id);
    const denied = { ...all, runs: async () => new Set<string>() };
    expect((await page(denied)).rows).toEqual([]);
    await expect(
      retryCustomerMemoryActivity(
        pool,
        org,
        actor,
        { contact_id: contact, job_id: id, revision: view.revision, request_key: randomUUID() },
        denied,
      ),
    ).rejects.toThrow("customer_memory_source_unavailable");
    await pool.query("update ai_workbench_runs set scope=$2 where id=$1", [
      run,
      { contactId: randomUUID() },
    ]);
    expect(
      (await page({ conversations: all.conversations, runs: async () => new Set([run]) })).rows,
    ).toEqual([]);
  });
  it("rejects foreign tenants and anonymized contacts", async () => {
    await seed();
    await expect(
      loadCustomerMemoryActivity(pool, randomUUID(), actor, contact, null, all),
    ).rejects.toThrow("customer_memory_contact_unavailable");
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1,$2,$3)", [
      org,
      contact,
      actor,
    ]);
    await expect(page()).rejects.toThrow("customer_memory_contact_unavailable");
  });
  it("walks an empty private-heavy batch and preserves equal-microsecond continuation without exposing private rows", async () => {
    const privateConv = conv,
      publicConv = randomUUID(),
      channel = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
      [channel, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [publicConv, org, contact, channel],
    );
    for (const [count, c, created] of [
      [510, privateConv, "2026-11-12T12:00:00.123456Z"],
      [23, publicConv, "2026-11-11T12:00:00.123456Z"],
    ] as const)
      await pool.query(
        "insert into job_queue(organization_id,contact_id,kind,status,created_at,payload) select $1,$2,'customer_memory_extract','done',$4::timestamptz,$5::jsonb from generate_series(1,$3)",
        [
          org,
          contact,
          count,
          created,
          JSON.stringify({
            source: { ...source(), conversation_id: c },
            memory_result: { status: "unavailable" },
          }),
        ],
      );
    const access = {
      ...all,
      conversations: async (ids: string[]) => new Set(ids.filter((id) => id === publicConv)),
    };
    const first = await page(access);
    expect(first).toMatchObject({ rows: [], has_more: true, coverage: "partial" });
    const second = await page(access, first.cursor);
    expect(second.rows).toHaveLength(20);
    const third = await page(access, second.cursor);
    expect(third.rows).toHaveLength(3);
    expect(third.has_more).toBe(false);
    expect(new Set([...second.rows, ...third.rows].map((r) => r.id)).size).toBe(23);
    expect(JSON.stringify([...second.rows, ...third.rows])).not.toContain(privateConv);
  });
});
