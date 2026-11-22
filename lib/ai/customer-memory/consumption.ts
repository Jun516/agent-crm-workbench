import type { Pool } from "pg";
import type { RunModelCallInput } from "@/lib/agent-engine/edge/llm/run-model-call";
import { withMemoryContact } from "./authority";
import { recordMemoryAudit } from "./audit";
import {
  loadCustomerMemoryContext,
  refreshCustomerContextMessages,
  CUSTOMER_MEMORY_INSTRUCTION,
  type CustomerMemoryContext,
  type CustomerMemoryScope,
} from "./context";

async function recordConsumption(
  pool: Pool,
  input: RunModelCallInput,
  scope: CustomerMemoryScope,
  snapshot: CustomerMemoryContext,
  callId: string | null,
  outcome: "success" | "error",
) {
  if (snapshot.organizationId !== input.tenantId || snapshot.contactId !== scope.contactId)
    throw new Error("customer_memory_receipt_scope_invalid");
  const written = await withMemoryContact(pool, input.tenantId, scope.contactId, async (db) => {
    if (input.workbenchRunId) {
      const run = (
        await db.query<{ id: string; parent_run_id: string | null }>(
          `select r.id,r.parent_run_id from ai_workbench_runs r
        where r.organization_id=$1 and r.id=$2 and (r.scope->>'contactId'=$3 or
          (coalesce(r.scope->>'contactId','')='' and (
            exists(select 1 from crm_leads l where l.organization_id=r.organization_id and l.id::text=r.scope->>'leadId' and l.contact_id=$3::uuid)
            or exists(select 1 from conversations c where c.organization_id=r.organization_id and c.id::text=r.scope->>'conversationId' and c.contact_id=$3::uuid)))) for share`,
          [input.tenantId, input.workbenchRunId, scope.contactId],
        )
      ).rows[0];
      if (!run) throw new Error("customer_memory_run_unavailable");
    }
    if (
      scope.conversationId &&
      !(
        await db.query(
          "select id from conversations where organization_id=$1 and contact_id=$2 and id=$3 for share",
          [input.tenantId, scope.contactId, scope.conversationId],
        )
      ).rows.length
    )
      throw new Error("customer_memory_conversation_unavailable");
    if (
      scope.draftId &&
      !(
        await db.query(
          `select id from ai_reply_drafts where organization_id=$1 and contact_id=$2 and conversation_id=$3 and id=$4
      and ($5::uuid is null or generation_token=$5) for share`,
          [
            input.tenantId,
            scope.contactId,
            scope.conversationId,
            scope.draftId,
            scope.draftGenerationToken ?? null,
          ],
        )
      ).rows.length
    )
      throw new Error("customer_memory_draft_unavailable");
    if (
      input.jobId &&
      !(
        await db.query(
          `select j.id from job_queue j where j.organization_id=$1 and j.id=$2 and (
      j.contact_id=$3 or ($4::uuid is not null and j.contact_id is null and exists(select 1 from ai_workbench_runs r
        where r.organization_id=j.organization_id and r.id=$4 and j.payload->>'runId' in (r.id::text,r.parent_run_id::text)))) for share`,
          [input.tenantId, input.jobId, scope.contactId, input.workbenchRunId ?? null],
        )
      ).rows.length
    )
      throw new Error("customer_memory_job_unavailable");
    if (
      callId &&
      !(
        await db.query("select id from llm_calls where organization_id=$1 and id=$2", [
          input.tenantId,
          callId,
        ])
      ).rows.length
    )
      throw new Error("customer_memory_call_unavailable");
    const created = await db.query(
      `insert into ai_customer_memory_recalls(id,organization_id,contact_id,run_id,conversation_id,draft_id,draft_generation_token,job_id,call_id,
      purpose,call_outcome,status,provider_status,coverage,returned_count,business_coverage,injected_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict(id) do nothing returning id`,
      [
        snapshot.id,
        input.tenantId,
        scope.contactId,
        input.workbenchRunId ?? null,
        scope.conversationId ?? null,
        scope.draftId ?? null,
        scope.draftGenerationToken ?? null,
        input.jobId ?? null,
        callId,
        input.purpose ?? "agent_turn",
        outcome,
        snapshot.status,
        snapshot.providerStatus,
        snapshot.coverage,
        snapshot.memories.length,
        snapshot.businessCoverage,
        snapshot.injectedAt,
      ],
    );
    for (const memory of snapshot.memories)
      await db.query(
        `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,recall_id,memory_id,memory_revision,policy_revision,
      memory_type,risk_level,locked,needs_review,confirmed_by,confirmed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing`,
        [
          input.tenantId,
          scope.contactId,
          input.workbenchRunId ?? null,
          snapshot.id,
          memory.id,
          memory.revision,
          memory.policy_revision,
          memory.memory_type,
          memory.risk_level,
          memory.locked,
          memory.needs_review,
          memory.confirmed_by,
          memory.confirmed_at,
        ],
      );
    return created.rows.length > 0;
  });
  if (written)
    await recordMemoryAudit(pool, input.tenantId, scope.contactId, "ai.customer_memory_used", {
      recall_id: snapshot.id,
      run_id: input.workbenchRunId ?? null,
      draft_id: scope.draftId ?? null,
      call_id: callId,
      returned_count: snapshot.memories.length,
      coverage: snapshot.coverage,
    });
}

/** Transient request context; only runtime-confirmed consumption becomes a SQL receipt. */
export function createCustomerMemoryCall(
  pool: Pool,
  input: RunModelCallInput,
  scope: CustomerMemoryScope,
  loader: typeof loadCustomerMemoryContext = loadCustomerMemoryContext,
) {
  const pending = new Map<string, CustomerMemoryContext>();
  const consumed = new Set<string>();
  const recorded = new Set<string>();
  // Pi can surface a failed context transform as an empty assistant result.
  // Preserve the trusted precondition failure across that runtime boundary.
  let refreshFailure: { error: unknown } | null = null;
  const call: RunModelCallInput = {
    ...input,
    system: [input.system ?? "", CUSTOMER_MEMORY_INSTRUCTION].filter(Boolean).join("\n\n"),
    transformContext: async (messages, signal) => {
      try {
        const base = input.transformContext
          ? await input.transformContext(messages, signal)
          : messages;
        const current = await loader(
          pool,
          input.tenantId,
          { ...scope, runId: input.workbenchRunId },
          signal,
        );
        pending.set(`customer-memory:${current.id}`, current);
        return refreshCustomerContextMessages(base, current);
      } catch (error) {
        refreshFailure = { error };
        throw error;
      }
    },
    contextProbes: (messages) => [
      ...(input.contextProbes?.(messages) ?? []),
      ...[...pending].flatMap(([id, snapshot]) =>
        messages.some(
          (m) =>
            m.role === "user" &&
            (typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("")) === snapshot.content,
        )
          ? [{ id, userText: snapshot.marker }]
          : [],
      ),
    ],
    onEvent: async (event) => {
      const id = event.data.probeId;
      if (event.type === "model_context_consumed" && typeof id === "string" && pending.has(id))
        consumed.add(id);
      await input.onEvent?.(event);
    },
  };
  return {
    input: call,
    async finish(callId: string | null, outcome: "success" | "error") {
      for (const id of consumed) {
        if (recorded.has(id)) continue;
        await recordConsumption(
          pool,
          input,
          scope,
          pending.get(id)!,
          callId,
          refreshFailure ? "error" : outcome,
        );
        recorded.add(id);
      }
      if (refreshFailure && outcome === "success") throw refreshFailure.error;
    },
  };
}
