import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { changeCustomerMemoryLifecycle } from "@/lib/ai/customer-memory/lifecycle";
import { audit } from "@/lib/audit";
import type * as Lifecycle from "@/lib/ai/customer-memory/lifecycle";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/ai/customer-memory/lifecycle", async (original) => ({
  ...(await original<typeof Lifecycle>()),
  changeCustomerMemoryLifecycle: vi.fn(),
}));
const org = "a0000000-0000-4000-8000-000000000001",
  actor = "a0000000-0000-4000-8000-000000000002";
const input = {
  contact_id: "a0000000-0000-4000-8000-000000000003",
  memory_id: "a0000000-0000-4000-8000-000000000004",
  expected_revision: 3,
  action: "set_lock",
  locked: false,
};
const req = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/customer-memory/lifecycle", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: actor },
    org: { orgId: org, role: "agent", name: "Synthetic" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(changeCustomerMemoryLifecycle).mockResolvedValue({
    id: input.memory_id,
    action: "set_lock",
  });
});
describe("memory lifecycle route", () => {
  it("uses the server tenant/actor and records the explicit revision and gesture", async () => {
    expect((await PATCH(req(input))).status).toBe(200);
    expect(changeCustomerMemoryLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      org,
      actor,
      input,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.customer_memory_lifecycle_changed",
        organizationId: org,
        actorUserId: actor,
        metadata: { action: "set_lock", expected_revision: 3, locked: false },
      }),
    );
  });
  it("rejects supplied organization/actor and missing revisions before mutation", async () => {
    expect((await PATCH(req({ ...input, organization_id: org, actor }))).status).toBe(400);
    expect((await PATCH(req({ ...input, expected_revision: undefined }))).status).toBe(400);
    expect(changeCustomerMemoryLifecycle).not.toHaveBeenCalled();
  });
  it("blocks read-only support before any write", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await PATCH(req(input))).status).toBe(403);
    expect(changeCustomerMemoryLifecycle).not.toHaveBeenCalled();
  });
  it.each([
    ["customer_memory_owner_required", 403],
    ["customer_memory_manager_required", 403],
    ["customer_memory_stale_revision", 409],
    ["customer_memory_unlock_required", 409],
    ["customer_memory_business_fact_changed", 409],
    ["customer_memory_memory_unavailable", 404],
    ["memory_lock_requires_durable", 400],
  ])("maps %s honestly without audit", async (error, status) => {
    vi.mocked(changeCustomerMemoryLifecycle).mockRejectedValue(new Error(error));
    expect((await PATCH(req(input))).status).toBe(status);
    expect(audit).not.toHaveBeenCalled();
  });
});
