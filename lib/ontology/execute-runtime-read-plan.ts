import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { McpContext } from "@/lib/mcp/types";
import { executeWithIdentity } from "./read-plan-internal";

/**
 * Server-only adapter: #34 supplies version and effective pipeline restriction
 * from its runtime, never from model arguments. The database rechecks the token,
 * organization and version. A trusted workbench run supplies its persisted
 * read scope; other runtimes are bounded by their configured pipelines.
 * The token creator's current visibility is an additional ceiling, not the
 * identity of the agent. Missing/revoked creator membership fails closed.
 */
export async function executeRuntimeReadPlan(
  plan: unknown,
  context: McpContext,
  runtime: {
    versionId: string;
    runId: string;
    pipelineIds: readonly string[] | null;
    workbenchRunId?: string;
  },
  signal?: AbortSignal,
) {
  const actor = context.actor;
  if (
    actor.type !== "ai_agent" ||
    !actor.agent_id ||
    actor.api_token_id !== context.apiTokenId ||
    context.role !== "ai_operator" ||
    context.requestId !== runtime.runId ||
    (runtime.pipelineIds !== null && runtime.pipelineIds.length > 100)
  )
    throw new Error("ontology_forbidden");
  let pool;
  try {
    pool = getRequestPool();
  } catch {
    throw new Error("ontology_read_unavailable");
  }
  return executeWithIdentity(
    pool,
    plan,
    {
      userId: "",
      organizationId: context.organizationId,
      aal: "aal1",
      pipelineIds: runtime.pipelineIds,
      runtime: {
        tokenId: context.apiTokenId,
        agentId: actor.agent_id,
        versionId: runtime.versionId,
        runId: runtime.runId,
        workbenchRunId: runtime.workbenchRunId,
      },
    },
    signal,
  );
}
