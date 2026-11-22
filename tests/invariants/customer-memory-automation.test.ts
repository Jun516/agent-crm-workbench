import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createCustomerMemoryQueueHandler } from "@/lib/ai/customer-memory/jobs";
import { runCustomerMemoryExtraction } from "@/lib/ai/customer-memory/extraction";
import { runCustomerMemoryConsolidation } from "@/lib/ai/customer-memory/consolidation";
import { loadMemoryReviewPage } from "@/lib/ai/customer-memory/review-pages";
import { saveCustomerMemory, readConfirmedCustomerMemory } from "@/lib/ai/integrations/mem0";
import {
  LlmNotConfiguredError,
  type runModelCall,
} from "@/lib/agent-engine/edge/llm/run-model-call";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
let org: string,
  contact: string,
  actor: string,
  channel: string,
  conversation: string,
  message: string;
const worker = "memory-test-worker";
beforeEach(async () => {
  org = randomUUID();
  contact = randomUUID();
  actor = randomUUID();
  channel = randomUUID();
  conversation = randomUUID();
  message = randomUUID();
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    actor,
    `${actor}@memory.test.invalid`,
  ]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Memory automation','Memory automation','Asia/Taipei')",
    [org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Synthetic customer')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,service_revision) values($1,$2,$3,$4,1)",
    [conversation, org, contact, channel],
  );
  await pool.query(
    `insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,body,service_revision)
    values($1,$2,$3,$4,$5,'text','inbound','Please use email. Never phone in the evening.',1)`,
    [message, org, contact, conversation, channel],
  );
});
afterAll(() => pool.end());
async function job(
  kind: "customer_memory_extract" | "customer_memory_consolidate",
  source?: Record<string, unknown>,
) {
  const input = source ?? {
    contact_id: contact,
    source_kind: "conversation_close",
    conversation_id: conversation,
    service_revision: 1,
    until_at: (
      await pool.query(
        `select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`,
      )
    ).rows[0].t,
    source_run_id: null,
    run_after: new Date().toISOString(),
  };
  return (
    await pool.query<JobRow>(
      `insert into job_queue(organization_id,contact_id,kind,payload,status,locked_by,locked_at)
    values($1,$2,$3,$4,'running',$5,clock_timestamp()) returning *,locked_at::text claim_acquired_at`,
      [org, contact, kind, { source: input }, worker],
    )
  ).rows[0]!;
}
const candidate = () => ({
  category: "communication_context",
  memory_type: "communication_preference",
  body: "Prefers email",
  confidence: 0.9,
  evidence: [{ message_id: message, excerpt: "Please use email." }],
  conflicts_with: [],
});
function model(
  output:
    Record<string, unknown> | ((material: Record<string, unknown>) => unknown | Promise<unknown>),
) {
  const call = vi.fn(
    async (_db: unknown, _cfg: unknown, input: Parameters<typeof runModelCall>[2]) => {
      expect(input.purpose).toBe("customer_memory_extract");
      expect(Object.keys(input.tools ?? {})).toEqual(["submit_customer_memory_review"]);
      const material = JSON.parse(String(input.messages[0]?.content));
      const value = typeof output === "function" ? await output(material) : output;
      const submit = input.tools!.submit_customer_memory_review!;
      if (!submit.execute) throw new Error("missing submit");
      await submit.execute(value, { toolCallId: "fixture", messages: [], context: {} });
      return {} as Awaited<ReturnType<typeof runModelCall>>;
    },
  );
  return call;
}
async function memory(body: string, extra: Record<string, unknown> = {}) {
  return saveCustomerMemory(pool, org, actor, {
    contact_id: contact,
    request_key: randomUUID(),
    category: "preference",
    body,
    confirmed: true,
    ...extra,
  });
}

describe("actual source events and durable extraction", () => {
  it("closes a service, queues the old revision once, and produces only an evidence-backed L2 candidate", async () => {
    await pool.query("select public.fn_service_status($1,$2,'closed',1)", [org, conversation]);
    const event = (
      await pool.query<EventRow>(
        "select * from event_log where organization_id=$1 and event_type='customer_memory.extract'",
        [org],
      )
    ).rows[0]!;
    expect(event.payload).toMatchObject({
      source_kind: "conversation_close",
      service_revision: 1,
      contact_id: contact,
    });
    const handler = createCustomerMemoryQueueHandler(() => pool);
    expect((await handler.handle(event)).status).toBe("ok");
    await handler.handle(event);
    expect(
      (await pool.query("select count(*)::int n from job_queue where organization_id=$1", [org]))
        .rows[0].n,
    ).toBe(1);
    const claimed = (
      await pool.query<JobRow>(
        "update job_queue set status='running',locked_by=$2,locked_at=clock_timestamp() where organization_id=$1 returning *,locked_at::text claim_acquired_at",
        [org, worker],
      )
    ).rows[0]!;
    const call = model({ candidates: [candidate()], conflicts: [] });
    await runCustomerMemoryExtraction(pool, {}, claimed, worker, { callModel: call });
    expect(call).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query(
          "select status,source_kind from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows[0],
    ).toMatchObject({ status: "pending", source_kind: "conversation_close" });
    expect((await readConfirmedCustomerMemory(pool, org, contact)).memories).toEqual([]);
    expect(
      (
        await pool.query(
          "select excerpt from ai_customer_memory_evidence where organization_id=$1",
          [org],
        )
      ).rows[0].excerpt,
    ).toBe("Please use email.");
  });
  it("checkpoint cadence is per service, delayed for idle, and never copies a summary to L1", async () => {
    await pool.query(
      `insert into lead_checkpoints(organization_id,contact_id,conversation_id,service_revision,rolling_summary)
      select $1::uuid,$2::uuid,$3::uuid,1,'Agent summary is not a confirmed fact' from generate_series(1,5)`,
      [org, contact, conversation],
    );
    const events = await pool.query(
      "select payload,next_attempt_at>now() delayed from event_log where organization_id=$1 and event_type='customer_memory.extract'",
      [org],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].delayed).toBe(true);
    expect(events.rows[0].payload.source_kind).toBe("checkpoint");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memories where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("skips an idle checkpoint if new conversation activity has arrived", async () => {
    const j = await job("customer_memory_extract", {
      contact_id: contact,
      source_kind: "checkpoint",
      conversation_id: conversation,
      service_revision: 1,
      until_at: new Date().toISOString(),
      source_run_id: null,
      run_after: new Date().toISOString(),
    });
    await pool.query(
      "update conversations set last_message_at=now()+interval '1 minute' where id=$1",
      [conversation],
    );
    const call = model({ candidates: [], conflicts: [] });
    await runCustomerMemoryExtraction(pool, {}, j, worker, { callModel: call });
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects an invented excerpt or another source ID before any profile write", async () => {
    const j = await job("customer_memory_extract");
    const invalid = {
      ...candidate(),
      evidence: [{ message_id: message, excerpt: "Agent summary is not a confirmed fact" }],
    };
    await expect(
      runCustomerMemoryExtraction(pool, {}, j, worker, {
        callModel: model({ candidates: [invalid], conflicts: [] }),
      }),
    ).rejects.toThrow("evidence_outside_source");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("does not write after losing its exact lease while the model was running", async () => {
    const j = await job("customer_memory_extract");
    const call = model(async () => {
      await pool.query(
        "update job_queue set locked_by='new-worker',locked_at=clock_timestamp() where id=$1",
        [j.id],
      );
      return { candidates: [candidate()], conflicts: [] };
    });
    await expect(
      runCustomerMemoryExtraction(pool, {}, j, worker, { callModel: call }),
    ).rejects.toThrow("claim_lost");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("makes missing provider configuration visible without auto-promoting or a retry storm", async () => {
    const j = await job("customer_memory_extract");
    const call = vi.fn(async () => {
      throw new LlmNotConfiguredError();
    });
    await runCustomerMemoryExtraction(pool, {}, j, worker, { callModel: call });
    expect(
      (await pool.query("select payload->'memory_result' r from job_queue where id=$1", [j.id]))
        .rows[0].r,
    ).toMatchObject({ status: "unavailable", reason: "model_not_configured" });
  });
  it("flags an L0 order conflict for review and leaves the SQL business value and locked body intact", async () => {
    const m = await memory("Prefers card payment", {
      locked: true,
      memory_type: "commercial_preference",
    });
    await pool.query(
      "insert into orders(organization_id,contact_id,external_id,external_provider,status,total_cents,ordered_at,payment_method) values($1,$2,'synthetic-order','shopify','paid',25000,now(),'wire')",
      [org, contact],
    );
    const j = await job("customer_memory_extract", {
      contact_id: contact,
      source_kind: "business_change",
      conversation_id: null,
      service_revision: null,
      until_at: new Date().toISOString(),
      source_run_id: null,
      run_after: new Date().toISOString(),
    });
    const call = model((material) => {
      const facts = material.businessFacts as {
        facts: { kind: string; id: string; revision: string }[];
      };
      const fact = facts.facts.find((f) => f.kind === "order")!;
      return {
        candidates: [],
        conflicts: [
          {
            memory_id: m.id,
            source_kind: "order",
            source_id: fact.id,
            source_revision: fact.revision,
            field: "payment_method",
            explanation: "Recent paid order uses another method",
          },
        ],
      };
    });
    await runCustomerMemoryExtraction(pool, {}, j, worker, { callModel: call });
    expect(
      (
        await pool.query("select body,locked,needs_review from ai_customer_memories where id=$1", [
          m.id,
        ])
      ).rows[0],
    ).toEqual({ body: "Prefers card payment", locked: true, needs_review: true });
    expect(
      (
        await pool.query("select payment_method,total_cents from orders where organization_id=$1", [
          org,
        ])
      ).rows[0],
    ).toMatchObject({ payment_method: "wire", total_cents: "25000" });
    expect(
      (
        await pool.query(
          "select kind,business_field from ai_customer_memory_conflicts where organization_id=$1",
          [org],
        )
      ).rows[0],
    ).toEqual({ kind: "l0_l1", business_field: "payment_method" });
  });
  it("rechecks privacy after the model and cannot save an anonymized customer's candidate", async () => {
    const j = await job("customer_memory_extract");
    await expect(
      runCustomerMemoryExtraction(pool, {}, j, worker, {
        callModel: model(async () => {
          await pool.query(
            "select public.fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())",
            [org, contact],
          );
          return { candidates: [candidate()], conflicts: [] };
        }),
      }),
    ).rejects.toThrow("contact_unavailable");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("does not flag L1 from an L0 snapshot that changed while the model was running", async () => {
    const m = await memory("Prefers card payment");
    const order = (
      await pool.query(
        "insert into orders(organization_id,contact_id,external_id,external_provider,status,total_cents,ordered_at,payment_method) values($1,$2,'changing-order','shopify','paid',25000,now(),'wire') returning id",
        [org, contact],
      )
    ).rows[0].id;
    const j = await job("customer_memory_extract");
    await runCustomerMemoryExtraction(pool, {}, j, worker, {
      callModel: model(async (material) => {
        const f = (
          material.businessFacts as { facts: { id: string; revision: string }[] }
        ).facts.find((f) => f.id === order)!;
        await pool.query("update orders set payment_method='card' where id=$1", [order]);
        return {
          candidates: [],
          conflicts: [
            {
              memory_id: m.id,
              source_kind: "order",
              source_id: order,
              source_revision: f.revision,
              field: "payment_method",
              explanation: "Superseded observation",
            },
          ],
        };
      }),
    });
    expect(
      (await pool.query("select needs_review from ai_customer_memories where id=$1", [m.id]))
        .rows[0].needs_review,
    ).toBe(false);
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_conflicts where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("flags contradictory confirmed memories but never rewrites either locked body", async () => {
    const a = await memory("Email only", { locked: true }),
      b = await memory("Phone only", { locked: true });
    const j = await job("customer_memory_extract");
    await runCustomerMemoryExtraction(pool, {}, j, worker, {
      callModel: model({
        candidates: [],
        conflicts: [],
        memory_conflicts: [
          { memory_id: a.id, other_memory_id: b.id, explanation: "Opposing channels" },
        ],
      }),
    });
    expect(
      (
        await pool.query(
          "select body,locked,needs_review from ai_customer_memories where organization_id=$1 order by body",
          [org],
        )
      ).rows,
    ).toEqual([
      { body: "Email only", locked: true, needs_review: true },
      { body: "Phone only", locked: true, needs_review: true },
    ]);
  });
  it("emits completed root-task and changed-business events, and exposes helper RPCs only to service role", async () => {
    await memory("Prefers email");
    const agent = randomUUID(),
      run = randomUUID();
    await pool.query(
      "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Memory fixture','Read only')",
      [agent, org],
    );
    await pool.query(
      "insert into ai_workbench_runs(id,organization_id,agent_id,task,mode,scope) values($1,$2,$3,'Memory fixture','inspect',$4)",
      [run, org, agent, { contactId: contact, conversationId: conversation }],
    );
    await pool.query("update ai_workbench_runs set status='completed' where id=$1", [run]);
    const order = (
      await pool.query(
        "insert into orders(organization_id,contact_id,external_id,external_provider,status,total_cents,ordered_at) values($1,$2,'event-order','shopify','paid',25000,now()) returning id",
        [org, contact],
      )
    ).rows[0].id;
    await pool.query("update orders set payment_method='wire' where id=$1", [order]);
    const sources = (
      await pool.query(
        "select payload->>'source_kind' kind from event_log where organization_id=$1 and event_type='customer_memory.extract' order by kind",
        [org],
      )
    ).rows;
    expect(sources).toEqual([{ kind: "business_change" }, { kind: "workbench_complete" }]);
    expect(
      (
        await pool.query(
          "select has_function_privilege('anon','public.fn_ai_memory_schedule_night(uuid,uuid,timestamptz)','execute') anon,has_function_privilege('authenticated','public.fn_ai_memory_emit_extract(uuid,uuid,text,uuid,bigint,timestamptz,uuid,timestamptz,text)','execute') browser,has_function_privilege('service_role','public.fn_ai_memory_schedule_night(uuid,uuid,timestamptz)','execute') service",
        )
      ).rows[0],
    ).toEqual({ anon: false, browser: false, service: true });
  });
});

describe("nightly consolidation", () => {
  async function manyConfirmed() {
    return (
      await pool.query<{ id: string; body: string }>(
        `insert into ai_customer_memories(organization_id,contact_id,request_key,subject_key,category,body,content_hash,memory_type,risk_level,created_at)
      select $1,$2,gen_random_uuid(),repeat('a',64),'preference','Synthetic review preference '||n,encode(extensions.digest('Synthetic review preference '||n,'sha256'),'hex'),'communication_preference','medium','2020-01-01T00:00:00Z' from generate_series(1,113) n returning id,body`,
        [org, contact],
      )
    ).rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  it("durably reviews every pair across more than 100 memories without increasing a model request beyond 100", async () => {
    const rows = await manyConfirmed(),
      first = rows[0]!,
      last = rows.at(-1)!;
    await pool.query(
      "update ai_customer_memories set locked=true,memory_type='constraint',risk_level='high' where organization_id=$1 and id=$2",
      [org, first.id],
    );
    let current = await job("customer_memory_extract");
    const root = current.id;
    current.payload.source = {
      ...(current.payload.source as Record<string, unknown>),
      source_kind: "maintenance_review",
      conversation_id: null,
      service_revision: null,
    };
    await pool.query("update job_queue set payload=$3 where organization_id=$1 and id=$2", [
      org,
      root,
      current.payload,
    ]);
    const pairs = new Set<string>(),
      seen = new Set<string>(),
      events = new Set<string>();
    const call = model((material) => {
      expect(material.conflictOnly).toBe(true);
      const ids = (material.confirmedMemories as Array<{ id: string }>).map((m) => m.id);
      expect(ids.length).toBeLessThanOrEqual(100);
      ids.forEach((id) => seen.add(id));
      for (let a = 0; a < ids.length; a++)
        for (let b = a + 1; b < ids.length; b++) pairs.add([ids[a], ids[b]].sort().join(":"));
      return {
        candidates: [],
        conflicts: [],
        memory_conflicts:
          ids.includes(first.id) && ids.includes(last.id)
            ? [
                {
                  memory_id: first.id,
                  other_memory_id: last.id,
                  explanation: "Synthetic opposite preferences across distant pages",
                },
              ]
            : [],
      };
    });
    const handler = createCustomerMemoryQueueHandler(() => pool);
    for (let step = 0; step < 12; step++) {
      await runCustomerMemoryExtraction(pool, {}, current, worker, { callModel: call });
      await pool.query(
        "update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1 and id=$2",
        [org, current.id],
      );
      const next = (
        await pool.query<EventRow>(
          "select * from event_log where organization_id=$1 and event_type='customer_memory.extract' and payload->>'review_root'=$2 order by created_at,id",
          [org, root],
        )
      ).rows.find((e) => !events.has(e.id));
      if (!next) break;
      events.add(next.id);
      await handler.handle(next);
      await handler.handle(next);
      current = (
        await pool.query<JobRow>(
          "update job_queue set status='running',locked_by=$3,locked_at=clock_timestamp() where organization_id=$1 and source_event_id=$2 returning *,locked_at::text claim_acquired_at",
          [org, next.id, worker],
        )
      ).rows[0]!;
    }
    expect(call).toHaveBeenCalledTimes(6);
    expect(seen.size).toBe(113);
    expect(pairs.size).toBe((113 * 112) / 2);
    expect(events.size).toBe(5);
    const actual = (
      await pool.query(
        "select body,locked,needs_review from ai_customer_memories where organization_id=$1 and id=$2",
        [org, first.id],
      )
    ).rows[0];
    expect(actual).toMatchObject({ body: first.body, locked: true, needs_review: true });
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_conflicts where organization_id=$1 and kind='l1_l1'",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_candidates where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("changes the nightly review fingerprint when a memory beyond the first 101 rows changes", async () => {
    const rows = await manyConfirmed();
    const runNight = async () => {
      const current = await job("customer_memory_consolidate", {
        contact_id: contact,
        run_after: new Date().toISOString(),
      });
      await runCustomerMemoryConsolidation(pool, current, worker);
      await pool.query(
        "update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1 and id=$2",
        [org, current.id],
      );
    };
    await runNight();
    await pool.query(
      "update ai_customer_memories set body='Changed beyond first page',content_hash=repeat('f',64),policy_revision=policy_revision+1 where organization_id=$1 and id=$2",
      [org, rows.at(-1)!.id],
    );
    await runNight();
    expect(
      (
        await pool.query(
          "select count(*)::int n from event_log where organization_id=$1 and event_type='customer_memory.extract' and payload->>'source_kind'='maintenance_review'",
          [org],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("keeps a review page boundary after retirement and excludes facts created after its horizon", async () => {
    const rows = await manyConfirmed();
    const horizon = (
      await pool.query(
        `select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`,
      )
    ).rows[0].t;
    const first = await loadMemoryReviewPage(pool, org, contact, horizon);
    expect(first.memories).toHaveLength(50);
    await pool.query(
      "update ai_customer_memories set body='',deleted_at=now(),sync_state='deleted' where organization_id=$1 and id=$2",
      [org, rows[0]!.id],
    );
    const later = randomUUID();
    await pool.query(
      "insert into ai_customer_memories(id,organization_id,contact_id,request_key,subject_key,category,body,content_hash) values($1,$2,$3,$1,repeat('a',64),'preference','Created after horizon',repeat('e',64))",
      [later, org, contact],
    );
    const next = await loadMemoryReviewPage(pool, org, contact, horizon, first.next!);
    expect(next.memories).toHaveLength(99);
    expect(new Set(next.memories.map((m) => m.id)).size).toBe(99);
    expect(next.memories.map((m) => m.id)).not.toContain(later);
    expect(next.memories.map((m) => m.id)).not.toContain(rows[0]!.id);
  });
  it("cannot publish a review continuation after losing its exact worker lease", async () => {
    await manyConfirmed();
    const current = await job("customer_memory_extract");
    current.payload.source = {
      ...(current.payload.source as Record<string, unknown>),
      source_kind: "maintenance_review",
      conversation_id: null,
      service_revision: null,
    };
    const call = model(async () => {
      await pool.query(
        "update job_queue set locked_by='replacement-worker',locked_at=clock_timestamp() where organization_id=$1 and id=$2",
        [org, current.id],
      );
      return { candidates: [], conflicts: [], memory_conflicts: [] };
    });
    await expect(
      runCustomerMemoryExtraction(pool, {}, current, worker, { callModel: call }),
    ).rejects.toThrow("customer_memory_job_claim_lost");
    expect(
      (
        await pool.query(
          "select count(*)::int n from event_log where organization_id=$1 and payload->>'review_root'=$2",
          [org, current.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("expires only temporary facts, preserves locked content and unknown-write cleanup receipts, and schedules another night", async () => {
    const locked = await memory("Never phone at night", {
      locked: true,
      memory_type: "constraint",
    });
    const expiring = await memory("This promotion only", {
      memory_type: "temporary_request",
      ttl_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second',write_outcome='unknown',sync_state='reconcile' where id=$1",
      [expiring.id],
    );
    const j = await job("customer_memory_consolidate", {
      contact_id: contact,
      run_after: new Date().toISOString(),
    });
    await runCustomerMemoryConsolidation(pool, j, worker);
    expect(
      (
        await pool.query("select body,locked,deleted_at from ai_customer_memories where id=$1", [
          locked.id,
        ])
      ).rows[0],
    ).toEqual({ body: "Never phone at night", locked: true, deleted_at: null });
    expect(
      (
        await pool.query(
          "select body,sync_state,write_outcome,remote_deleted_at from ai_customer_memories where id=$1",
          [expiring.id],
        )
      ).rows[0],
    ).toEqual({
      body: "",
      sync_state: "deleted",
      write_outcome: "unknown",
      remote_deleted_at: null,
    });
    expect(
      (
        await pool.query(
          "select count(*)::int n from event_log where organization_id=$1 and event_type='customer_memory.consolidate' and next_attempt_at>now()",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select (next_attempt_at at time zone 'Asia/Taipei')::time::text t from event_log where organization_id=$1 and event_type='customer_memory.consolidate'",
          [org],
        )
      ).rows[0].t,
    ).toBe("02:00:00");
  });
  it("pages through more than 200 same-timestamp candidates, safely clusters/merges exact duplicates and repairs their keys", async () => {
    await pool.query(
      `insert into ai_customer_memory_candidates(organization_id,contact_id,request_key,category,memory_type,body,risk_level,normalized_hash,source_kind)
      select $1::uuid,$2::uuid,gen_random_uuid(),'preference','communication_preference','Preference '||case when i=205 then '1' else i::text end,
       'medium',md5(i::text)||md5(i::text),'explicit' from generate_series(1,205) i`,
      [org, contact],
    );
    const j = await job("customer_memory_consolidate", {
      contact_id: contact,
      run_after: new Date().toISOString(),
    });
    await runCustomerMemoryConsolidation(pool, j, worker);
    expect(
      (
        await pool.query(
          "select status,count(*)::int n from ai_customer_memory_candidates where organization_id=$1 group by status order by status",
          [org],
        )
      ).rows,
    ).toEqual([
      { status: "merged", n: 1 },
      { status: "pending", n: 204 },
    ]);
    expect(
      (await pool.query("select payload->'memory_result' r from job_queue where id=$1", [j.id]))
        .rows[0].r,
    ).toMatchObject({ status: "completed", merged: 1, normalized: 204 });
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memories where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
