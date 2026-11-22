import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { McpContext } from "@/lib/mcp/types";
import { executeWithIdentity } from "./read-plan-internal";

/** Server-side MCP token context only, after the existing bearer validation. */
export async function executeMcpReadPlan(plan: unknown, context: McpContext, signal?: AbortSignal) {
  if (context.actor.type !== "api_token" || context.actor.id !== context.apiTokenId)
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
      apiTokenId: context.apiTokenId,
    },
    signal,
  );
}
