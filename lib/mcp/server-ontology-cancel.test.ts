import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  callback: null as null | ((args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>),
  handler: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(_name: string, _definition: unknown, callback: typeof state.callback) {
      state.callback = callback;
    }
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("./audit", () => ({ auditMcpToolCall: vi.fn() }));
vi.mock("./tools", () => ({
  allTools: [
    {
      name: "ontology_query",
      description: "test",
      inputSchema: {},
      requiresRole: "agent",
      requiresScope: "mcp:read",
      handler: state.handler,
    },
  ],
}));
import { createMcpServer } from "./server";
import type { McpAuthResult } from "./auth";

beforeEach(() => {
  state.handler.mockReset();
  createMcpServer(
    {
      organizationId: "org",
      apiTokenId: "token",
      role: "agent",
      actor: { type: "api_token", id: "token" },
      scopes: ["mcp:read"],
    } as McpAuthResult,
    "request",
  );
});

it("passes the authenticated MCP request cancellation signal to the tool", async () => {
  state.handler.mockResolvedValue({ status: "unanswerable" });
  const controller = new AbortController();
  await state.callback!({}, { signal: controller.signal });
  expect(state.handler).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      signal: controller.signal,
      organizationId: "org",
      apiTokenId: "token",
    }),
  );
});

it("does not return errors containing private semantic request or database details", async () => {
  state.handler.mockRejectedValue(new Error("private query details"));
  const result = await state.callback!({}, { signal: new AbortController().signal });
  expect(result).toEqual({
    isError: true,
    content: [{ type: "text", text: "ontology_tool_unavailable" }],
  });
});
