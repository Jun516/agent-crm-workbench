import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryRequestRuntime } from "../agent-runtime/fixtures/memory-request-runtime";
import { planFollowupTiming } from "@/lib/agent-engine/agent/followup-flow-classify";
import {
  createFollowupTurnHandler,
  type FollowupTurnDeps,
} from "@/lib/agent-engine/agent/followup-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { saveCustomerMemory } from "@/lib/ai/integrations/mem0";
import { proposeCustomerMemory } from "@/lib/ai/customer-memory/candidates";
import {
  readCurrentServiceBoundary,
  requireCurrentServiceBoundary,
} from "@/lib/atendimento/fronteira-server";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
let org: string,
  contact: string,
  actor: string,
  other: string,
  conversation: string,
  channel: string,
  run: string;
beforeEach(async () => {
  org = randomUUID();
  contact = randomUUID();
  actor = randomUUID();
  other = randomUUID();
  conversation = randomUUID();
  channel = randomUUID();
  run = randomUUID();
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    actor,
    `${actor}@memory.test.invalid`,
  ]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Consumption fixture','Consumption fixture')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
    [actor, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$3,'Current customer'),($2,$3,'Other customer')",
    [contact, other, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,service_revision) values($1,$2,$3,$4,1)",
    [conversation, org, contact, channel],
  );
  const agent = randomUUID();
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Consumption agent','Only SQL')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_workbench_runs(id,organization_id,agent_id,task,mode,scope,status) values($1,$2,$3,'Check current customer','inspect',$4,'running')",
    [run, org, agent, { contactId: contact, conversationId: conversation }],
  );
});
afterAll(() => pool.end());

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const timingResponse = JSON.stringify({
  esperas: [{ node_id: "w1", aguardar_ms: 60000, motivo: "Respect communication constraints" }],
});
const context = (): LeadContext => ({
  lead_id: contact,
  contact_id: contact,
  conversation_id: conversation,
  contact: { name: "Current customer", phone: null, email: null, tags: [], is_blocked: false },
  last_human_decision: null,
  messages: [],
});
async function memory(body: string, extra: Record<string, unknown> = {}, target = contact) {
  return saveCustomerMemory(pool, org, actor, {
    contact_id: target,
    request_key: randomUUID(),
    category: "preference",
    body,
    confirmed: true,
    ...extra,
  });
}
async function plan(ctx = context(), beforeRead?: () => Promise<void>) {
  const job = randomUUID();
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn','{}')",
    [job, org, contact],
  );
  const requests: string[] = [];
  const runtime = memoryRequestRuntime(timingResponse, (request) =>
    requests.push(JSON.stringify(request)),
  );
  const result = await planFollowupTiming(
    pool,
    { anthropicApiKey: "deterministic-fixture-no-network" },
    {
      tenantId: org,
      leadId: contact,
      jobId: job,
    },
    {
      context: ctx,
      esperas: [{ node_id: "w1", label: "Contact", min_ms: 60000, max_ms: 3600000 }],
    },
    {
      log,
      runtime,
      ...(beforeRead ? { beforeRead } : {}),
    },
  );
  return { requests, result, job };
}

describe("follow-up timing uses current confirmed SQL memory at the native request boundary", () => {
  it("keeps the real queued-turn caller on its source conversation when the contact has a newer conversation", async () => {
    await memory("ORIGIN_TIMING_CANARY: business hours only", {
      locked: true,
      memory_type: "constraint",
    });
    const source = await readCurrentServiceBoundary(pool, org, conversation);
    expect(source).not.toBeNull();
    const newerChannel = randomUUID(),
      newerConversation = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
      [newerChannel, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,last_message_at) values($1,$2,$3,$4,now()+interval '1 hour')",
      [newerConversation, org, contact, newerChannel],
    );
    const job = (
      await pool.query<JobRow>(
        `insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'followup_turn',$3) returning *`,
        [
          org,
          contact,
          {
            service_boundary: source,
            followup_enrollment_id: randomUUID(),
            node_id: "trigger",
            purpose: "plan_timing",
            waits: [{ node_id: "w1", label: "Contact", min_ms: 60000, max_ms: 3600000 }],
          },
        ],
      )
    ).rows[0]!;
    const requests: string[] = [];
    const completeFollowupTurn = vi.fn().mockResolvedValue(undefined);
    // This branch reads these dependencies only; sending is never invoked.
    const handler = createFollowupTurnHandler({
      log,
      llmCfg: { anthropicApiKey: "deterministic-fixture-no-network" },
      crmCfg: {
        supabase: createClient("http://127.0.0.1:1", "unused-offline-fixture", {
          auth: { persistSession: false },
        }),
      },
      knobs: {
        historyLimit: 20,
        maxContextTokens: 4000,
        notesIndexMaxTokens: 500,
        maxSteps: 1,
        queuedRetryDelayMs: 1000,
        breaker: {
          exactFailureWarn: 2,
          exactFailureBlock: 5,
          sameToolFailureWarn: 3,
          sameToolFailureHalt: 8,
          noProgressWarn: 3,
          noProgressBlock: 5,
        },
      },
      completeFollowupTurn,
      runtime: memoryRequestRuntime(timingResponse, (r) => requests.push(JSON.stringify(r))),
    } satisfies FollowupTurnDeps);
    await handler(job, pool, { workerId: "memory-timing-fixture" });
    expect(completeFollowupTurn).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        jobId: job.id,
        result: expect.objectContaining({ kind: "planned" }),
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("ORIGIN_TIMING_CANARY");
    expect(
      (
        await pool.query(
          "select conversation_id from ai_customer_memory_recalls where organization_id=$1 and job_id=$2",
          [org, job.id],
        )
      ).rows,
    ).toEqual([{ conversation_id: conversation }]);
  });
  it("sends valid locked constraints, excludes expired/candidate/foreign rows, and records only actual consumption", async () => {
    const locked = await memory("LOCKED_TIMING_CANARY: never contact after 18:00", {
      locked: true,
      memory_type: "constraint",
    });
    const expired = await memory("EXPIRED_TIMING_CANARY", {
      memory_type: "temporary_request",
      ttl_expires_at: "2099-01-01T00:00:00Z",
    });
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second' where id=$1",
      [expired.id],
    );
    await memory("FOREIGN_TIMING_CANARY", { locked: true }, other);
    await proposeCustomerMemory(
      pool,
      org,
      {
        contact_id: contact,
        request_key: randomUUID(),
        category: "preference",
        memory_type: "constraint",
        body: "CANDIDATE_TIMING_CANARY",
        evidence: [],
        conflicts_with: [],
      },
      { kind: "explicit", actor },
    );
    const originalBoundary = await readCurrentServiceBoundary(pool, org, conversation);
    expect(originalBoundary).not.toBeNull();
    const boundary = vi.fn(async () => requireCurrentServiceBoundary(pool, originalBoundary));
    const first = await plan(context(), boundary);
    expect(first.result.propostas).toHaveLength(1);
    expect(boundary).toHaveBeenCalled();
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]).toContain("LOCKED_TIMING_CANARY");
    expect(first.requests[0]).not.toMatch(
      /EXPIRED_TIMING_CANARY|CANDIDATE_TIMING_CANARY|FOREIGN_TIMING_CANARY/,
    );
    const receipts = (
      await pool.query(
        `select r.purpose,r.conversation_id,r.job_id,r.call_outcome,c.purpose as gateway_purpose,u.memory_id
      from ai_customer_memory_recalls r join ai_customer_memory_usage u on u.recall_id=r.id and u.organization_id=r.organization_id
      join llm_calls c on c.id=r.call_id and c.organization_id=r.organization_id where r.organization_id=$1`,
        [org],
      )
    ).rows;
    expect(receipts).toEqual([
      {
        purpose: "followup_decide_timing",
        gateway_purpose: "followup_decide_timing",
        conversation_id: conversation,
        job_id: first.job,
        call_outcome: "success",
        memory_id: locked.id,
      },
    ]);
    // Same LeadContext object, fresh SQL before the next actual model request.
    const newer = await memory("NEW_TIMING_CANARY: weekday mornings only", {
      locked: true,
      memory_type: "constraint",
    });
    const next = await plan();
    expect(next.requests[0]).toContain("NEW_TIMING_CANARY");
    expect(
      (
        await pool.query(
          "select memory_id from ai_customer_memory_usage where organization_id=$1 and memory_id=$2",
          [org, newer.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("revalidates current service before a provider request and leaves no consumed-memory receipt when stale", async () => {
    await memory("STALE_SERVICE_CANARY", { locked: true });
    const originalBoundary = await readCurrentServiceBoundary(pool, org, conversation);
    expect(originalBoundary).not.toBeNull();
    await pool.query(
      "update conversations set service_revision=service_revision+1 where id=$1 and organization_id=$2",
      [conversation, org],
    );
    const job = randomUUID();
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn','{}')",
      [job, org, contact],
    );
    const requests: unknown[] = [];
    await expect(
      planFollowupTiming(
        pool,
        { anthropicApiKey: "deterministic-fixture-no-network" },
        {
          tenantId: org,
          leadId: contact,
          jobId: job,
        },
        {
          context: context(),
          esperas: [{ node_id: "w1", label: "Contact", min_ms: 60000, max_ms: 3600000 }],
        },
        {
          log,
          runtime: memoryRequestRuntime(timingResponse, (r) => requests.push(r)),
          beforeRead: async () => requireCurrentServiceBoundary(pool, originalBoundary),
        },
      ),
    ).rejects.toThrow("service_boundary_stale");
    expect(requests).toHaveLength(0);
    expect(
      (
        await pool.query("select id from ai_customer_memory_recalls where organization_id=$1", [
          org,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it("refuses a conversation owned by another contact before sending any customer context", async () => {
    await memory("PRIVATE_TIMING_CANARY", { locked: true });
    const foreignConversation = randomUUID();
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [foreignConversation, org, other, channel],
    );
    await expect(plan({ ...context(), conversation_id: foreignConversation })).rejects.toThrow(
      "customer_memory_conversation_unavailable",
    );
    expect(
      (
        await pool.query("select id from ai_customer_memory_recalls where organization_id=$1", [
          org,
        ])
      ).rows,
    ).toHaveLength(0);
  });
});
