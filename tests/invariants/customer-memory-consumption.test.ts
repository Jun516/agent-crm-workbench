import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryRequestRuntime } from "../agent-runtime/fixtures/memory-request-runtime";
import { loadMemoryEvaluationRecalls } from "@/lib/ai/customer-memory/evaluation";
import { evaluateMemoryRecallPolicy, memoryPolicyFailure } from "@/lib/ai/evals/memory-policy";
import { loadMemoryCandidatePage } from "@/lib/ai/customer-memory/queue";
import { createCustomerMemoryCall } from "@/lib/ai/customer-memory/consumption";
import {
  loadCustomerMemoryContext,
  refreshCustomerContextMessages,
} from "@/lib/ai/customer-memory/context";
import { saveCustomerMemory } from "@/lib/ai/integrations/mem0";
import { proposeCustomerMemory } from "@/lib/ai/customer-memory/candidates";
import {
  correctCustomerMemoryUsage,
  loadCustomerMemoryUsage,
  resolveMemoryUsageTarget,
} from "@/lib/ai/customer-memory/usage";
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
const scope = () => ({
  contactId: contact,
  conversationId: conversation,
  task: "email and customer constraints",
});
const input = () => ({
  tenantId: org,
  workbenchRunId: run,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "Check customer" }],
});
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
async function consume(call: ReturnType<typeof createCustomerMemoryCall>) {
  const messages = await call.input.transformContext!([
    { role: "user", content: "Check customer" },
  ]);
  const probes = call.input.contextProbes!(messages);
  expect(probes).toHaveLength(1);
  await call.input.onEvent!({ type: "model_context_consumed", data: { probeId: probes[0]!.id } });
  await call.finish(null, "success");
  return messages;
}
describe("current SQL context and actual-consumption receipts", () => {
  it("walks beyond private-heavy batches and paginates equal-microsecond candidates without loss", async () => {
    const privateConversation = randomUUID();
    const privateChannel = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
      [privateChannel, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [privateConversation, org, contact, privateChannel],
    );
    for (const [count, source, kind, body, rank, at] of [
      [
        510,
        privateConversation,
        "checkpoint",
        "PRIVATE_QUEUE_CANARY",
        "high",
        "2026-11-10T00:00:00.123456Z",
      ],
      [
        65,
        conversation,
        "checkpoint",
        "Visible queue item",
        "medium",
        "2026-11-11T00:00:00.123456Z",
      ],
      [
        3,
        privateConversation,
        "explicit",
        "Shared explicit suggestion",
        "high",
        "2026-11-11T01:00:00.123456Z",
      ],
    ] as const) {
      await pool.query(
        `with inserted as (insert into ai_customer_memory_candidates(organization_id,contact_id,request_key,category,memory_type,body,risk_level,normalized_hash,source_kind,created_at)
        select $1,$2,gen_random_uuid(),'preference','relationship_context',$4||' '||n::text,$5,md5(n::text||$4)||md5(n::text||$4),$6,$7::timestamptz from generate_series(1,$8::int) n returning id)
        insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,conversation_id,excerpt,observed_at) select $1,$2,id,$3,'Synthetic evidence',now() from inserted`,
        [org, contact, source, body, rank, kind, at, count],
      );
    }
    const readable = async (ids: string[]) => new Set(ids.filter((id) => id === conversation));
    const first = await loadMemoryCandidatePage(pool, org, contact, "pending", null, readable);
    expect(first.rows).toHaveLength(0);
    expect(first).toMatchObject({ has_more: true, scan_partial: true });
    expect(first.cursor).not.toBeNull();
    const next = await loadMemoryCandidatePage(
      pool,
      org,
      contact,
      "pending",
      first.cursor,
      readable,
    );
    expect(next.rows).toHaveLength(50);
    expect(next.has_more).toBe(true);
    const last = await loadMemoryCandidatePage(
      pool,
      org,
      contact,
      "pending",
      next.cursor,
      readable,
    );
    expect(last.rows).toHaveLength(18);
    expect(last.has_more).toBe(false);
    const visible = [...next.rows, ...last.rows];
    expect(new Set(visible.map((r) => r.id)).size).toBe(68);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE_QUEUE_CANARY");
    expect(JSON.stringify(visible)).not.toContain(privateConversation);
    expect(
      visible
        .filter((r) => r.source_kind === "explicit")
        .every((r) => Array.isArray(r.evidence) && r.evidence.length === 0),
    ).toBe(true);
    expect(
      (await loadMemoryCandidatePage(pool, randomUUID(), contact, "pending", null, readable)).rows,
    ).toEqual([]);
  });
  it("evaluates native task-time receipts without demanding every irrelevant preference", async () => {
    const locked = await memory("Never call at night", { locked: true, memory_type: "constraint" });
    for (let i = 0; i < 12; i++) await memory(`Unrelated preference ${i}`);
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    const receipts = await loadMemoryEvaluationRecalls(pool, org, [run]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.required_memory_ids).toContain(locked.id);
    expect(receipts[0]!.memory_ids).toHaveLength(10);
    expect(evaluateMemoryRecallPolicy(receipts).some((f) => memoryPolicyFailure(f.code))).toBe(
      false,
    );
    expect(await loadMemoryEvaluationRecalls(pool, randomUUID(), [run])).toEqual([]);
  });
  it("detects independently missing locks, expired injected rows and incorrect metadata", async () => {
    const locked = await memory("Locked constraint", { locked: true, memory_type: "constraint" });
    const ephemeral = await memory("Temporary preference", {
      memory_type: "temporary_request",
      ttl_expires_at: "2099-01-01T00:00:00Z",
    });
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    await pool.query(
      "delete from ai_customer_memory_usage where organization_id=$1 and memory_id=$2",
      [org, locked.id],
    );
    await pool.query(
      "update ai_customer_memory_recalls set returned_count=1 where organization_id=$1",
      [org],
    );
    // Stable SQL fixture represents a preference already expired at injection.
    await pool.query(
      `update ai_customer_memories m set ttl_expires_at=r.injected_at-interval '1 second',updated_at=r.injected_at-interval '1 second'
      from ai_customer_memory_recalls r where r.organization_id=$1 and m.organization_id=r.organization_id and m.id=$2`,
      [org, ephemeral.id],
    );
    await pool.query(
      "update ai_customer_memory_usage set risk_level='high',memory_type='constraint' where organization_id=$1",
      [org],
    );
    const findings = evaluateMemoryRecallPolicy(
      await loadMemoryEvaluationRecalls(pool, org, [run]),
    );
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        "memory_policy_locked_missing",
        "memory_policy_invalid_injected",
        "memory_policy_metadata_mismatch",
      ]),
    );
    expect(JSON.stringify(findings)).not.toContain(contact);
  });
  it("treats later human policy changes as historical uncertainty, validates scope and honors current privacy", async () => {
    const m = await memory("Confirmed preference", { locked: true });
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    await pool.query(
      "update ai_customer_memories set policy_revision=policy_revision+1,updated_at=clock_timestamp() where id=$1",
      [m.id],
    );
    let receipts = await loadMemoryEvaluationRecalls(pool, org, [run]);
    expect(evaluateMemoryRecallPolicy(receipts).map((f) => f.code)).toContain(
      "memory_policy_history_unverifiable",
    );
    expect(evaluateMemoryRecallPolicy(receipts).some((f) => memoryPolicyFailure(f.code))).toBe(
      false,
    );
    await pool.query("update ai_workbench_runs set scope=$2 where id=$1", [
      run,
      { contactId: other },
    ]);
    receipts = await loadMemoryEvaluationRecalls(pool, org, [run]);
    expect(evaluateMemoryRecallPolicy(receipts).map((f) => f.code)).toContain(
      "memory_policy_scope_mismatch",
    );
    await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [
      org,
      contact,
    ]);
    expect(await loadMemoryEvaluationRecalls(pool, org, [run])).toEqual([]);
  });
  it("scopes conversational draft receipts and feedback to the current draft generation", async () => {
    await memory("Use email for invoices");
    const draft = randomUUID(),
      version = randomUUID(),
      token = randomUUID();
    const agent = (await pool.query("select agent_id from ai_workbench_runs where id=$1", [run]))
      .rows[0].agent_id;
    await pool.query(
      "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,channel_session_id) values($1,$2,$3,99,'Fixture','fixture','fixture','draft',$4)",
      [version, org, agent, channel],
    );
    await pool.query(
      `insert into ai_reply_drafts(id,organization_id,contact_id,conversation_id,agent_id,agent_version_id,channel_session_id,service_boundary,context_revision,operation_revision,generation_token,status,original_body)
      values($1,$2,$3,$4,$5,$6,$7,'{}',1,1,$8,'pending','Synthetic draft')`,
      [draft, org, contact, conversation, agent, version, channel, token],
    );
    const call = createCustomerMemoryCall(
      pool,
      { tenantId: org, purpose: "agent_preview", messages: [] },
      { ...scope(), draftId: draft, draftGenerationToken: token },
    );
    await consume(call);
    const target = await resolveMemoryUsageTarget(pool, org, { context: "draft", id: draft });
    const loaded = await loadCustomerMemoryUsage(pool, org, target);
    expect(loaded.usage).toHaveLength(1);
    await pool.query(
      "update user_organizations set role='agent' where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    expect(
      await correctCustomerMemoryUsage(pool, org, actor, {
        context: "draft",
        id: draft,
        usage_id: loaded.usage[0]!.id,
        reason: "Draft-specific correction",
      }),
    ).toMatchObject({ memory_flagged: true });
    await pool.query("update ai_reply_drafts set generation_token=$2 where id=$1", [
      draft,
      randomUUID(),
    ]);
    const regenerated = await resolveMemoryUsageTarget(pool, org, { context: "draft", id: draft });
    expect((await loadCustomerMemoryUsage(pool, org, regenerated)).usage).toHaveLength(0);
    await expect(
      correctCustomerMemoryUsage(pool, org, actor, {
        context: "draft",
        id: draft,
        usage_id: loaded.usage[0]!.id,
        reason: "Old generation cannot be corrected here",
      }),
    ).rejects.toThrow("usage_unavailable");
    await expect(
      loadCustomerMemoryContext(pool, org, {
        ...scope(),
        draftId: draft,
        draftGenerationToken: token,
      }),
    ).rejects.toThrow("draft_unavailable");
  });
  it("binds legacy selected-conversation runs to their verified contact before task completion", async () => {
    await pool.query("update ai_workbench_runs set scope=$2 where id=$1", [
      run,
      { conversationId: conversation },
    ]);
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    expect(
      (
        await pool.query(
          "select scope->>'contactId' contact_id from ai_workbench_runs where id=$1",
          [run],
        )
      ).rows[0].contact_id,
    ).toBe(contact);
    await pool.query("update ai_workbench_runs set status='completed' where id=$1", [run]);
    await expect(loadCustomerMemoryContext(pool, org, { ...scope(), runId: run })).rejects.toThrow(
      "run_unavailable",
    );
  });
  it("removes stale L3 checkpoints and recursively strips nested old L1 snapshots", async () => {
    const current = await loadCustomerMemoryContext(pool, org, scope());
    const messages = refreshCustomerContextMessages(
      [
        {
          role: "tool",
          toolName: "crm_get_checkpoint",
          toolCallId: "old-checkpoint",
          content: JSON.stringify({
            scope: { conversation_id: conversation, service_revision: 0 },
            checkpoint: { summary: "OLD_SERVICE_CANARY" },
            nested: { confirmedCustomerMemory: { body: "NESTED_OLD_L1_CANARY" } },
          }),
        },
      ],
      current,
    );
    expect(JSON.stringify(messages)).not.toMatch(/OLD_SERVICE_CANARY|NESTED_OLD_L1_CANARY/);
    expect(JSON.stringify(messages)).toContain("service_boundary_changed");
  });
  it("routes a correction to the exact used revision, preserving body and lock, and deduplicates feedback", async () => {
    const m = await memory("Do not call after 18:00", { locked: true, memory_type: "constraint" });
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    const target = await resolveMemoryUsageTarget(pool, org, { context: "workbench", id: run });
    const loaded = await loadCustomerMemoryUsage(pool, org, target);
    expect(loaded.usage).toHaveLength(1);
    const beforeWrite = async () => {
      expect(target.contactId).toBe(contact);
    };
    const feedback = {
      context: "workbench" as const,
      id: run,
      usage_id: loaded.usage[0]!.id,
      reason: "Customer changed their availability",
    };
    expect(await correctCustomerMemoryUsage(pool, org, actor, feedback, beforeWrite)).toMatchObject(
      { deduped: false, memory_flagged: true },
    );
    expect(
      await correctCustomerMemoryUsage(pool, org, actor, {
        ...feedback,
        reason: "Retry must not replace reason",
      }),
    ).toMatchObject({ deduped: true });
    expect(
      (
        await pool.query(
          "select body,locked,needs_review,review_reason from ai_customer_memories where id=$1",
          [m.id],
        )
      ).rows[0],
    ).toEqual({
      body: "Do not call after 18:00",
      locked: true,
      needs_review: true,
      review_reason: "usage_correction",
    });
    expect(
      (
        await pool.query("select correction_reason from ai_customer_memory_usage where id=$1", [
          feedback.usage_id,
        ])
      ).rows[0].correction_reason,
    ).toBe(feedback.reason);
  });
  it("keeps historical correction without marking a newer human-reviewed revision", async () => {
    const m = await memory("Old interpretation");
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    const usageId = (
      await pool.query("select id from ai_customer_memory_usage where organization_id=$1", [org])
    ).rows[0].id;
    await pool.query(
      "update ai_customer_memories set policy_revision=policy_revision+1,needs_review=false where id=$1",
      [m.id],
    );
    expect(
      await correctCustomerMemoryUsage(pool, org, actor, {
        context: "workbench",
        id: run,
        usage_id: usageId,
        reason: "Historical interpretation was wrong",
      }),
    ).toMatchObject({ memory_flagged: false });
    expect(
      (await pool.query("select needs_review from ai_customer_memories where id=$1", [m.id]))
        .rows[0].needs_review,
    ).toBe(false);
  });
  it("rolls correction back on lost conversation access or revoked membership", async () => {
    await memory("Use email");
    await consume(createCustomerMemoryCall(pool, input(), scope()));
    const usageId = (
      await pool.query("select id from ai_customer_memory_usage where organization_id=$1", [org])
    ).rows[0].id;
    const feedback = {
      context: "conversation" as const,
      id: conversation,
      usage_id: usageId,
      reason: "No longer correct",
    };
    await expect(
      correctCustomerMemoryUsage(pool, org, actor, feedback, async () => {
        throw new Error("session_scope_denied");
      }),
    ).rejects.toThrow("session_scope_denied");
    expect(
      (await pool.query("select corrected_at from ai_customer_memory_usage where id=$1", [usageId]))
        .rows[0].corrected_at,
    ).toBeNull();
    await pool.query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    await expect(correctCustomerMemoryUsage(pool, org, actor, feedback)).rejects.toThrow(
      "forbidden",
    );
  });
  it("paginates equal-microsecond usage records without losing rows and hides retired bodies", async () => {
    const m = await memory("Never expose after retirement");
    for (let i = 0; i < 3; i++) await consume(createCustomerMemoryCall(pool, input(), scope()));
    await pool.query(
      `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,recall_id,memory_id,memory_revision,policy_revision,memory_type,risk_level,locked,needs_review,confirmed_at)
      select organization_id,contact_id,run_id,id,$2,(select content_hash from ai_customer_memories where id=$2),1,'communication_preference','medium',false,false,now() from ai_customer_memory_recalls where organization_id=$1 on conflict do nothing`,
      [org, m.id],
    );
    // Many parent receipts, each with one unique usage; all share a timestamp.
    await pool.query(
      `insert into ai_customer_memory_recalls(id,organization_id,contact_id,run_id,purpose,call_outcome,status,provider_status,coverage,returned_count,business_coverage,injected_at,consumed_at)
      select gen_random_uuid(),$1,$2,$3,'fixture','success','ok','disabled','complete',1,'complete',now(),now() from generate_series(1,55)`,
      [org, contact, run],
    );
    await pool.query(
      `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,recall_id,memory_id,memory_revision,policy_revision,memory_type,risk_level,locked,needs_review,confirmed_at)
      select organization_id,contact_id,run_id,id,$2,(select content_hash from ai_customer_memories where id=$2),1,'communication_preference','medium',false,false,now() from ai_customer_memory_recalls where organization_id=$1 on conflict do nothing`,
      [org, m.id],
    );
    await pool.query(
      "update ai_customer_memory_usage set used_at='2026-11-12T10:00:00.123456Z' where organization_id=$1",
      [org],
    );
    const target = await resolveMemoryUsageTarget(pool, org, { context: "workbench", id: run });
    const first = await loadCustomerMemoryUsage(pool, org, target);
    expect(first.usage).toHaveLength(50);
    expect(first.meta.has_more).toBe(true);
    const next = await loadCustomerMemoryUsage(pool, org, target, first.meta.cursor!);
    expect(next.usage).toHaveLength(8);
    expect(new Set([...first.usage, ...next.usage].map((r) => r.id)).size).toBe(58);
    await pool.query("update ai_customer_memories set deleted_at=now() where id=$1", [m.id]);
    expect(
      (await loadCustomerMemoryUsage(pool, org, target)).usage.every(
        (r) => r.body === null && r.retired,
      ),
    ).toBe(true);
    await expect(loadCustomerMemoryUsage(pool, org, target, "invalid")).rejects.toThrow(
      "memory_cursor_invalid",
    );
  });
  it("injects valid locks and separate L0, excludes expired/candidate/other-contact bodies, and records nothing before acknowledgement", async () => {
    const locked = await memory("Never call at night", { locked: true, memory_type: "constraint" });
    const expired = await memory("Old temporary offer", {
      memory_type: "temporary_request",
      ttl_expires_at: "2099-01-01T00:00:00Z",
    });
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second' where id=$1",
      [expired.id],
    );
    await saveCustomerMemory(pool, org, actor, {
      contact_id: other,
      request_key: randomUUID(),
      category: "preference",
      body: "FOREIGN_CONTACT_CANARY",
      confirmed: true,
    });
    await proposeCustomerMemory(
      pool,
      org,
      {
        contact_id: contact,
        request_key: randomUUID(),
        category: "preference",
        memory_type: "commercial_preference",
        body: "UNCONFIRMED_CANARY",
        evidence: [],
        conflicts_with: [],
      },
      { kind: "explicit", actor },
    );
    await pool.query(
      "insert into orders(organization_id,contact_id,external_provider,external_id,status,total_cents,ordered_at) values($1,$2,'shopify','receipt-order','paid',25000,now())",
      [org, contact],
    );
    const call = createCustomerMemoryCall(pool, input(), scope());
    const messages = await call.input.transformContext!([
      { role: "user", content: "Original task" },
    ]);
    const text = JSON.stringify(messages);
    expect(text).toContain(locked.id);
    expect(text).toContain("L0_business_facts");
    expect(text).toContain("25000");
    expect(text).not.toMatch(/Old temporary offer|UNCONFIRMED_CANARY|FOREIGN_CONTACT_CANARY/);
    await call.finish(null, "success");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_recalls where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
    const probe = call.input.contextProbes!(messages)[0]!;
    await call.input.onEvent!({ type: "model_context_consumed", data: { probeId: probe.id } });
    await call.finish(null, "success");
    await call.finish(null, "success");
    expect(
      (
        await pool.query(
          "select memory_id,locked,needs_review from ai_customer_memory_usage where organization_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ memory_id: locked.id, locked: true, needs_review: false }]);
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_recalls where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("uses the actual Pi request boundary with a deterministic provider and awaits asynchronous product callbacks", async () => {
    const m = await memory("Email is preferred", { locked: true });
    const call = createCustomerMemoryCall(
      pool,
      {
        ...input(),
        onEvent: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
      scope(),
    );
    const runtime = memoryRequestRuntime();
    const result = await runtime.run({
      systemPrompt: "Only SQL",
      prompt: "Check current customer",
      model: { provider: "memory-fixture", model: "memory-fixture", apiKey: "fixture" },
      transformContext: call.input.transformContext,
      contextProbes: call.input.contextProbes,
      onEvent: call.input.onEvent,
    });
    expect(result.events.filter((e) => e.type === "model_context_consumed")).toHaveLength(1);
    await call.finish(null, "success");
    expect(
      (
        await pool.query(
          "select memory_id from ai_customer_memory_usage where organization_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ memory_id: m.id }]);
  }, 20000);
  it("refreshes every request and removes old memory tool snapshots on resume", async () => {
    const m = await memory("First preference");
    const first = await loadCustomerMemoryContext(pool, org, scope());
    await pool.query(
      "update ai_customer_memories set ttl_expires_at=now()-interval '1 second',retention_policy='ephemeral' where id=$1",
      [m.id],
    );
    const next = await loadCustomerMemoryContext(pool, org, scope());
    const messages = refreshCustomerContextMessages(
      [
        { role: "user", content: first.content },
        {
          role: "tool",
          toolCallId: "t",
          toolName: "crm_get_contact",
          content: JSON.stringify({
            name: "Keep business data",
            confirmed_customer_memory: { memories: [{ body: "OLD_TOOL_CANARY" }] },
          }),
        },
      ],
      next,
    );
    expect(JSON.stringify(messages)).not.toMatch(/First preference|OLD_TOOL_CANARY/);
    expect(JSON.stringify(messages)).toContain("Keep business data");
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
  it("fails on a foreign subject/artifact and prevents privacy changes during recall from producing a receipt", async () => {
    await memory("Current confirmed memory");
    await expect(
      loadCustomerMemoryContext(pool, org, { ...scope(), contactId: other }),
    ).rejects.toThrow("conversation_unavailable");
    const call = createCustomerMemoryCall(pool, input(), scope());
    const messages = await call.input.transformContext!([{ role: "user", content: "Task" }]);
    const probe = call.input.contextProbes!(messages)[0]!;
    await call.input.onEvent!({ type: "model_context_consumed", data: { probeId: probe.id } });
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [
      org,
      contact,
    ]);
    await expect(call.finish(null, "success")).rejects.toThrow("contact_unavailable");
    expect(
      (
        await pool.query(
          "select count(*)::int n from ai_customer_memory_usage where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("records a consumed empty SQL selection without treating it as proof of no preference, and denies browser reads", async () => {
    const call = createCustomerMemoryCall(pool, input(), scope());
    await consume(call);
    expect(
      (
        await pool.query(
          "select returned_count,coverage,provider_status from ai_customer_memory_recalls where organization_id=$1",
          [org],
        )
      ).rows[0],
    ).toEqual({ returned_count: 0, coverage: "complete", provider_status: "disabled" });
    for (const role of ["anon", "authenticated"]) {
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(`set local role ${role}`);
        await expect(db.query("select * from ai_customer_memory_recalls")).rejects.toThrow(
          "permission denied",
        );
      } finally {
        await db.query("rollback");
        db.release();
      }
    }
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role service_role");
      expect(
        (
          await db.query(
            "select count(*)::int n from ai_customer_memory_recalls where organization_id=$1",
            [org],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.query("rollback");
      db.release();
    }
  });
});
