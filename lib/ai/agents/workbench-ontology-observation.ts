import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { appendWorkbenchEvent } from "./workbench-events";

/** Preserve only catalog metadata and the receipt; never copy rows or the question into events. */
export async function recordOntologyObservation(
  admin: SupabaseClient,
  input: { organizationId: string; runId: string; tool: string; result: unknown },
): Promise<void> {
  if (!input.tool.startsWith("ontology_") || !input.result || typeof input.result !== "object")
    return;
  const value = input.result as Record<string, unknown>;
  await appendWorkbenchEvent(admin, {
    organizationId: input.organizationId,
    runId: input.runId,
    type: "tool_completed",
    payload: {
      ontologyObservation: true,
      tool: input.tool,
      status: value.status,
      degraded: value.degraded,
      assumption: value.assumption,
      missing: value.missing,
      receipt: value.receipt,
      terms: value.candidates ?? value.terms,
      version: value.version,
      digest: value.digest,
      semantics: semanticReceipt(input.tool, value),
    },
  });
}

export function ontologyObjectScopeRefusal(
  tool: string,
  scope: { contactId?: string | null; leadId?: string | null; conversationId?: string | null },
) {
  if (tool !== "ontology_query" || !(scope.contactId || scope.leadId || scope.conversationId))
    return null;
  return {
    kind: "ontology_observation",
    status: "unanswerable",
    degraded: true,
    missing: [
      "A consulta semântica não pode representar o objeto selecionado; use as ferramentas de leitura existentes.",
    ],
  };
}

/** The database intersects the selected pipeline with trusted runtime authority. */
export function ontologyPipelineScope(scope: {
  pipelineId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
}): readonly string[] | null {
  if (scope.contactId || scope.leadId || scope.conversationId) return [];
  return scope.pipelineId ? [scope.pipelineId] : null;
}

/** Persist only bounded catalog IDs and recognized contract enums; no model text or rows. */
function semanticReceipt(tool: string, value: Record<string, unknown>) {
  const action = value.action as Record<string, unknown> | undefined;
  if (tool === "ontology_describe_action" && typeof action?.capability === "string" && catalogEntry(action.capability))
    return { type: "action", capability: action.capability };
  const outcome = value.outcome as Record<string, unknown> | undefined;
  if (tool !== "ontology_describe_outcome" || !outcome) return undefined;
  const checks = Array.isArray(outcome.checks) ? outcome.checks.slice(0, 2).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const check = item as Record<string, unknown>;
    if (check.kind === "customer_inbound_after_verified_send") return [{ kind: check.kind }];
    if (check.kind === "lead_status" && ["open", "won", "lost"].includes(String(check.expected)))
      return [{ kind: check.kind, expected: check.expected }];
    return [];
  }) : [];
  return { type: "outcome", revision: outcome.revision === 1 ? 1 : null, checks };
}
