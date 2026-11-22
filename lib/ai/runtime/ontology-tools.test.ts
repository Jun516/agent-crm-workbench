import { beforeEach, expect, it, vi } from "vitest";
import { pickToolsFromMcp, type PickToolsInput } from "./tools";
import type { McpContext } from "@/lib/mcp/types";
import { buildToolGrantScopes } from "@/lib/mcp/tool-grants";

const query = { question: "quais negócios estão abertos?" };
const { executeReadPlan } = vi.hoisted(() => ({ executeReadPlan: vi.fn() }));
vi.mock("@/lib/ontology/execute-runtime-read-plan", () => ({
  executeRuntimeReadPlan: executeReadPlan,
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn() }));

beforeEach(() => {
  executeReadPlan.mockReset().mockResolvedValue({ receipt: { partial: false }, rows: [] });
});

function configure(scopes: string[]): PickToolsInput {
  const ctx: McpContext = {
    organizationId: "org",
    role: "ai_operator",
    actor: {
      type: "ai_agent",
      id: "run",
      role: "ai_operator",
      agent_id: "agent",
      api_token_id: "token",
    },
    apiTokenId: "token",
    requestId: "run",
    ontologyRuntime: {
      versionId: "version",
      runId: "run",
      pipelineIds: ["pipeline"],
      signal: new AbortController().signal,
    },
    supabase: {} as McpContext["supabase"],
  };
  return {
    supabase: ctx.supabase,
    ctx,
    auth: {
      organizationId: ctx.organizationId,
      role: ctx.role,
      actor: ctx.actor,
      apiTokenId: ctx.apiTokenId,
      scopes,
    },
    toolIds: ["ontology_query"],
    handoffToolEnabled: false,
    pipelineIds: [],
    handoffSignal: { triggered: false },
  };
}

it("exposes denied semantic capabilities as degraded observations in the same tool call", async () => {
  const tools = pickToolsFromMcp(configure([]));
  const result = await tools.ontology_query!.execute!(query, {
    toolCallId: "call", messages: [], context: {},
  });
  expect(result).toMatchObject({
    kind: "ontology_observation",
    status: "unanswerable",
    degraded: true,
    missing: ["Acesso semântico recusado."],
  });
  expect(executeReadPlan).not.toHaveBeenCalled();
});

it("rechecks an exact grant when an already mounted semantic tool is called", async () => {
  const config = configure(["mcp:read", ...buildToolGrantScopes(["ontology_query"])]);
  const tools = pickToolsFromMcp(config);
  expect(tools.ontology_query).toBeDefined();
  config.auth.scopes = ["mcp:read", ...buildToolGrantScopes([])];
  expect(pickToolsFromMcp(config).ontology_query).toBeUndefined();
  const result = await tools.ontology_query!.execute!(query, {
    toolCallId: "call", messages: [], context: {},
  });
  expect(result).toMatchObject({ status: "unanswerable", degraded: true });
  expect(executeReadPlan).not.toHaveBeenCalled();
});

it.each(["invocation", "run"] as const)("cancels the scoped read when the %s is cancelled", async (origin) => {
  const config = configure(["mcp:read", ...buildToolGrantScopes(["ontology_query"])]);
  const run = new AbortController();
  const invocation = new AbortController();
  config.ctx.ontologyRuntime!.signal = run.signal;
  const tools = pickToolsFromMcp(config);
  const result = await tools.ontology_query!.execute!(query, {
    toolCallId: "call", messages: [], context: {}, abortSignal: invocation.signal,
  });
  expect(result).toMatchObject({ status: "full" });
  expect(executeReadPlan).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ organizationId: "org" }),
    expect.objectContaining({ versionId: "version", pipelineIds: ["pipeline"] }),
    expect.objectContaining({ aborted: false }),
  );
  const readSignal = executeReadPlan.mock.lastCall?.[3] as AbortSignal;
  (origin === "invocation" ? invocation : run).abort();
  expect(readSignal.aborted).toBe(true);
});
