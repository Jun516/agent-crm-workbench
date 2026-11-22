import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import {
  loadCustomerMemoryActivity,
  retryCustomerMemoryActivity,
} from "@/lib/ai/customer-memory/activity";
import { encodeMemoryCursor } from "@/lib/ai/customer-memory/cursor";
import { env } from "@/lib/env";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/ai/customer-memory/activity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCustomerMemoryActivity: vi.fn(),
  retryCustomerMemoryActivity: vi.fn(),
}));
const contact = "a0000000-0000-4000-8000-000000000001",
  job = "a0000000-0000-4000-8000-000000000002";
const input = {
  contact_id: contact,
  job_id: job,
  revision: "a".repeat(64),
  request_key: "a0000000-0000-4000-8000-000000000003",
};
const get = (extra = "") =>
  new NextRequest(
    `http://localhost/api/v1/ai/customer-memory/activity?contact_id=${contact}${extra}`,
  );
const post = (body: unknown = input) =>
  new NextRequest("http://localhost/api/v1/ai/customer-memory/activity", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor" },
    org: { orgId: "org", role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(loadCustomerMemoryActivity).mockResolvedValue({
    rows: [],
    cursor: null,
    has_more: false,
    coverage: "complete",
    can_retry: true,
  });
  vi.mocked(retryCustomerMemoryActivity).mockResolvedValue({
    id: job,
    status: "pending",
    deduped: false,
  });
});
describe("background memory activity API", () => {
  it("uses authenticated actor/tenant and protects page positions with actor-bound encryption", async () => {
    const position = { at: "2026-11-12T12:00:00.123456Z", id: job };
    const token = encodeMemoryCursor(
      position,
      { org: "org", actor: "actor", contact, resource: "activity" },
      env.INTERNAL_SECRET,
    );
    expect((await GET(get(`&cursor=${token}`))).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(loadCustomerMemoryActivity).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "actor",
      contact,
      position,
      expect.anything(),
    );
    expect((await GET(get(`&cursor=${token}A`))).status).toBe(400);
    const other = encodeMemoryCursor(
      position,
      { org: "org", actor: "other", contact, resource: "activity" },
      env.INTERNAL_SECRET,
    );
    expect((await GET(get(`&cursor=${other}`))).status).toBe(400);
  });
  it("encrypts skipped private positions in an empty partial page", async () => {
    const position = { at: "2026-11-12T12:00:00.123456Z", id: job };
    vi.mocked(loadCustomerMemoryActivity).mockResolvedValueOnce({
      rows: [],
      cursor: position,
      has_more: true,
      coverage: "partial",
      can_retry: true,
    });
    const result = await GET(get()),
      value = await result.json();
    expect(value.data).toEqual([]);
    expect(value.meta).toMatchObject({ has_more: true, coverage: "partial" });
    expect(value.meta.cursor).not.toContain(job);
    expect(value.meta.cursor).not.toContain(position.at);
  });
  it("rejects tenant overrides, malformed retry and role denial before any domain write", async () => {
    expect((await GET(get("&organization_id=foreign"))).status).toBe(400);
    expect((await POST(post({ ...input, organization_id: "foreign" }))).status).toBe(400);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await POST(post())).status).toBe(403);
    expect(retryCustomerMemoryActivity).not.toHaveBeenCalled();
  });
  it("honors support read-only and audits only the first successful retry with the authenticated actor", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
    expect((await POST(post())).status).toBe(403);
    expect(retryCustomerMemoryActivity).not.toHaveBeenCalled();
    expect((await POST(post())).status).toBe(200);
    expect(retryCustomerMemoryActivity).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "actor",
      input,
      expect.anything(),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.customer_memory_job_retried",
        actorUserId: "actor",
        organizationId: "org",
        resourceId: job,
      }),
    );
    vi.mocked(retryCustomerMemoryActivity).mockResolvedValueOnce({
      id: job,
      status: "pending",
      deduped: true,
    });
    expect((await POST(post())).status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["customer_memory_owner_required", 403],
    ["customer_memory_forbidden", 403],
    ["customer_memory_job_unavailable", 404],
    ["customer_memory_source_unavailable", 404],
    ["customer_memory_job_stale", 409],
    ["customer_memory_job_not_retryable", 409],
    ["PRIVATE_ERROR_CANARY", 503],
  ])("maps %s without exposing raw errors or inventing empty success", async (message, status) => {
    vi.mocked(retryCustomerMemoryActivity).mockRejectedValue(new Error(message as string));
    const result = await POST(post());
    expect(result.status).toBe(status);
    expect(JSON.stringify(await result.json())).not.toContain("PRIVATE_ERROR_CANARY");
    expect(audit).not.toHaveBeenCalled();
  });
});
