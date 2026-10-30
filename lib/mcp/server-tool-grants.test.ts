import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildToolGrantScopes } from "./tool-grants";
import type { McpAuthResult } from "./auth";

const state = vi.hoisted(() => ({ handler: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: state.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "crm_read_a",
      description: "Read A",
      inputSchema: { id: z.string() },
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      handler: state.handler,
    },
    {
      name: "crm_read_b",
      description: "Read B",
      inputSchema: { id: z.string() },
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      handler: state.handler,
    },
    {
      name: "crm_write_a",
      description: "Write A",
      inputSchema: { id: z.string() },
      requiresRole: "manager",
      requiresScope: "mcp:write",
      handler: state.handler,
    },
  ],
}));

const { createMcpServer } = await import("./server");
const cleanups: Array<() => Promise<void>> = [];

async function connect(scopes: string[], role: McpAuthResult["role"] = "manager") {
  const auth: McpAuthResult = {
    organizationId: "org-a",
    role,
    actor: { type: "api_token", id: "token-a", role },
    apiTokenId: "token-a",
    scopes,
  };
  const server = createMcpServer(auth, "request-a");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "grant-test", version: "1.0.0" });
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  return { client, auth };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.handler.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("MCP discovery and invocation honor the same token manifest", () => {
  it("lists and executes only the selected tool", async () => {
    const { client } = await connect(["mcp:read", ...buildToolGrantScopes(["crm_read_a"])]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["crm_read_a"]);
    await client.callTool({ name: "crm_read_a", arguments: { id: "contact-a" } });
    expect(state.handler).toHaveBeenCalledOnce();
    const denied = await client.callTool({ name: "crm_read_b", arguments: { id: "contact-a" } });
    expect(denied.isError).toBe(true);
    expect(state.handler).toHaveBeenCalledOnce();
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "crm_read_a", success: true }),
    );
  });

  it("an empty manifest exposes no tool", async () => {
    const { client } = await connect(["mcp:read", "mcp:write", ...buildToolGrantScopes([])]);
    expect((await client.listTools()).tools).toEqual([]);
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("an exact grant does not bypass role or coarse scope", async () => {
    const grant = buildToolGrantScopes(["crm_write_a"]);
    const noWrite = await connect(["mcp:read", ...grant]);
    expect((await noWrite.client.listTools()).tools).toEqual([]);
    const noRole = await connect(["mcp:write", ...grant], "viewer");
    expect((await noRole.client.listTools()).tools).toEqual([]);
  });

  it("revalidates a mounted tool at invocation instead of trusting discovery", async () => {
    const { client, auth } = await connect(["mcp:read", ...buildToolGrantScopes(["crm_read_a"])]);
    auth.scopes = ["mcp:read", ...buildToolGrantScopes([])];
    const result = await client.callTool({ name: "crm_read_a", arguments: { id: "contact-a" } });
    expect(result.isError).toBe(true);
    expect(state.handler).not.toHaveBeenCalled();
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
