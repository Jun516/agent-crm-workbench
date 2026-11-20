import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { readableMemoryConversations } from "@/lib/ai/customer-memory/source-access";
import {
  resolveMemoryUsageTarget,
  loadCustomerMemoryUsage,
  correctCustomerMemoryUsage,
} from "@/lib/ai/customer-memory/usage";
import type * as Usage from "@/lib/ai/customer-memory/usage";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query }) }));
vi.mock("@/lib/ai/customer-memory/source-access", () => ({ readableMemoryConversations: vi.fn() }));
vi.mock("@/lib/ai/customer-memory/usage", async (original) => ({
  ...(await original<typeof Usage>()),
  resolveMemoryUsageTarget: vi.fn(),
  loadCustomerMemoryUsage: vi.fn(),
  correctCustomerMemoryUsage: vi.fn(),
}));
const id = "a0000000-0000-4000-8000-000000000001",
  usageId = "a0000000-0000-4000-8000-000000000002";
const input = { context: "draft", id, usage_id: usageId, reason: "No longer correct" };
const target = {
  contactId: "contact",
  runIds: [],
  draftId: id,
  conversationId: "conversation",
  generationToken: "token",
  managerOnly: false,
};
const patch = (value = input) =>
  new NextRequest("http://localhost/api/v1/ai/customer-memory/usage", {
    method: "PATCH",
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor" },
    org: { orgId: "trusted-org", role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(resolveMemoryUsageTarget).mockResolvedValue(target);
  vi.mocked(readableMemoryConversations).mockImplementation(
    async (_org, ids) => new Set(ids.filter((id) => id !== "hidden-source")),
  );
  vi.mocked(loadCustomerMemoryUsage).mockResolvedValue({
    recalls: [],
    usage: [{ id: usageId, evidence_conversation_id: "hidden-source" }],
    meta: { has_more: false },
  } as never);
  vi.mocked(correctCustomerMemoryUsage).mockResolvedValue({
    id: usageId,
    deduped: false,
    memory_flagged: true,
  });
  query.mockResolvedValue({ rows: [{ id: "contact" }] });
});
describe("artifact memory usage API", () => {
  it("uses trusted tenant and masks inaccessible evidence conversation links", async () => {
    const result = await GET(
      new NextRequest(`http://localhost/api/v1/ai/customer-memory/usage?context=draft&id=${id}`),
    );
    expect(result.status).toBe(200);
    expect((await result.json()).data.usage[0].evidence_conversation_id).toBeNull();
    expect(loadCustomerMemoryUsage).toHaveBeenCalledWith(
      expect.anything(),
      "trusted-org",
      target,
      undefined,
    );
  });
  it("rejects extra tenant input before resolving any artifact", async () => {
    expect(
      (await PATCH(patch({ ...input, organization_id: "attacker" } as typeof input))).status,
    ).toBe(400);
    expect(resolveMemoryUsageTarget).not.toHaveBeenCalled();
  });
  it("revalidates conversation access and denies revoked sources", async () => {
    vi.mocked(readableMemoryConversations).mockResolvedValue(new Set());
    expect(
      (
        await GET(
          new NextRequest(
            `http://localhost/api/v1/ai/customer-memory/usage?context=draft&id=${id}`,
          ),
        )
      ).status,
    ).toBe(404);
    expect(loadCustomerMemoryUsage).not.toHaveBeenCalled();
  });
  it("denies read-only support and manager-only report correction", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await PATCH(patch())).status).toBe(403);
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
    vi.mocked(resolveMemoryUsageTarget).mockResolvedValue({ ...target, managerOnly: true });
    expect((await PATCH(patch({ ...input, context: "workbench" }))).status).toBe(403);
    expect(correctCustomerMemoryUsage).not.toHaveBeenCalled();
  });
  it("passes a fresh source-access fence to the correction transaction", async () => {
    expect((await PATCH(patch())).status).toBe(200);
    const args = vi.mocked(correctCustomerMemoryUsage).mock.calls[0]!;
    expect(args.slice(1, 4)).toEqual(["trusted-org", "actor", input]);
    vi.mocked(readableMemoryConversations).mockResolvedValue(new Set());
    await expect(args[4]!("conversation")).rejects.toThrow("conversation_unavailable");
  });
});
