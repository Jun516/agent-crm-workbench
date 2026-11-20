import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { loadCustomerMemoryMetrics } from "@/lib/ai/customer-memory/metrics";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/ai/customer-memory/metrics", () => ({ loadCustomerMemoryMetrics: vi.fn() }));
const id = "a0000000-0000-4000-8000-000000000001";
const req = (extra = "") =>
  new NextRequest(`http://localhost/api/v1/ai/customer-memory/metrics?contact_id=${id}${extra}`);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "trusted-actor" },
    org: { orgId: "trusted-org", role: "manager" },
  } as never);
  vi.mocked(loadCustomerMemoryMetrics).mockResolvedValue({ decided_count: 3 } as never);
});
describe("manager memory metrics API", () => {
  it("uses current server tenant and actor, guarded as manager", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(loadCustomerMemoryMetrics).toHaveBeenCalledWith(
      expect.anything(),
      "trusted-org",
      "trusted-actor",
      id,
    );
  });
  it("rejects tenant overrides and returns the actual role denial", async () => {
    expect((await GET(req("&organization_id=attacker"))).status).toBe(400);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await GET(req())).status).toBe(403);
    expect(loadCustomerMemoryMetrics).not.toHaveBeenCalled();
  });
  it.each([
    ["customer_memory_forbidden", 403],
    ["customer_memory_manager_required", 403],
    ["customer_memory_contact_unavailable", 404],
    ["database unavailable", 503],
  ])("maps %s without returning fabricated zero metrics", async (message, status) => {
    vi.mocked(loadCustomerMemoryMetrics).mockRejectedValue(new Error(message));
    const result = await GET(req());
    expect(result.status).toBe(status);
    expect((await result.json()).data).toBeUndefined();
  });
});
