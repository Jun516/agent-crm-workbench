import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PickToolsInput } from "./tools";
import { buildToolGrantScopes } from "@/lib/mcp/tool-grants";

const state = vi.hoisted(() => ({ handler: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: state.audit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/mcp/tools", () => {
  const allTools = ["crm_read_a", "crm_read_b", "crm_request_human_handoff"].map((name) => ({
    name,
    description: name,
    inputSchema: { id: z.string() },
    category: "read",
    requiresRole: "viewer",
    requiresScope: "mcp:read",
    handler: state.handler,
  }));
  return { allTools, getToolByName: (id: string) => allTools.find((tool) => tool.name === id) };
});

const { pickToolsFromMcp } = await import("./tools");

function input(): PickToolsInput {
  const ctx = {
    organizationId: "org-a",
    role: "agent" as const,
    actor: { type: "api_token" as const, id: "token-a", role: "agent" as const },
    apiTokenId: "token-a",
    requestId: "request-a",
    supabase: {} as PickToolsInput["supabase"],
  };
  return {
    supabase: ctx.supabase,
    ctx,
    auth: { ...ctx, scopes: ["mcp:read", ...buildToolGrantScopes(["crm_read_a"])] },
    toolIds: ["crm_read_a", "crm_read_b"],
    handoffToolEnabled: true,
    handoffSignal: { triggered: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.handler.mockResolvedValue({ ok: true });
});

describe("in-process MCP bridge exact grants", () => {
  it("does not mount out-of-manifest tools or auto-inject an ungranted handoff", () => {
    expect(Object.keys(pickToolsFromMcp(input()))).toEqual(["crm_read_a"]);
  });

  it("checks the same manifest again when an already mounted tool executes", async () => {
    const config = input();
    const mounted = pickToolsFromMcp(config);
    const execute = mounted.crm_read_a!.execute!;
    await execute({ id: "contact-a" }, { toolCallId: "one", messages: [], context: {} } as never);
    expect(state.handler).toHaveBeenCalledOnce();
    config.auth.scopes = ["mcp:read", ...buildToolGrantScopes([])];
    const denied = await execute({ id: "contact-a" }, {
      toolCallId: "two",
      messages: [],
      context: {},
    } as never);
    expect(denied).toHaveProperty("error");
    expect(state.handler).toHaveBeenCalledOnce();
    expect(state.audit).toHaveBeenLastCalledWith(expect.objectContaining({ success: false }));
  });
});
