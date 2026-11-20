import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { proposeCustomerMemory, decideCustomerMemory } from "@/lib/ai/customer-memory/candidates";
import { audit } from "@/lib/audit";
import type * as CandidateModule from "@/lib/ai/customer-memory/candidates";
const mocked = vi.hoisted(() => ({ query: vi.fn(), visible: [] as { id: string }[] }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocked.query }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        in: async () => ({ data: mocked.visible, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/ai/customer-memory/candidates", async (importOriginal) => ({
  ...(await importOriginal<typeof CandidateModule>()),
  proposeCustomerMemory: vi.fn(),
  decideCustomerMemory: vi.fn(),
}));
const org = "a0000000-0000-4000-8000-000000000001",
  actor = "a0000000-0000-4000-8000-000000000002";
const contact = "a0000000-0000-4000-8000-000000000003",
  id = "a0000000-0000-4000-8000-000000000004";
const visibleConversation = "a0000000-0000-4000-8000-000000000005",
  hiddenConversation = "a0000000-0000-4000-8000-000000000006";
const request = (body: unknown, method = "POST") =>
  new NextRequest("http://localhost/api/v1/ai/customer-memory/candidates", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const proposal = {
  contact_id: contact,
  request_key: id,
  category: "preference",
  memory_type: "communication_preference",
  body: "Email preferred",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocked.query.mockReset();
  mocked.visible = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: actor },
    org: { orgId: org, role: "agent", name: "Synthetic" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(proposeCustomerMemory).mockResolvedValue({
    id,
    status: "pending",
    deduped: false,
    revision_token: "r1",
  });
});
describe("candidate routes retain trusted actor, tenant, and evidence visibility", () => {
  it("passes the server actor/org to the explicit proposal writer and audits the mutation", async () => {
    expect((await POST(request(proposal))).status).toBe(200);
    expect(proposeCustomerMemory).toHaveBeenCalledWith(
      expect.anything(),
      org,
      expect.objectContaining(proposal),
      { kind: "explicit", actor },
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.customer_memory_proposed",
        actorUserId: actor,
        organizationId: org,
      }),
    );
  });
  it("does not let a request supply tenant or confirmation authority", async () => {
    expect(
      (await POST(request({ ...proposal, organization_id: org, actor, confirmed: true }))).status,
    ).toBe(400);
    expect(proposeCustomerMemory).not.toHaveBeenCalled();
  });
  it("does not accept evidence hidden by the real session RLS client", async () => {
    expect(
      (
        await POST(
          request({ ...proposal, evidence: [{ message_id: id, excerpt: "Private quote" }] }),
        )
      ).status,
    ).toBe(404);
    expect(proposeCustomerMemory).not.toHaveBeenCalled();
  });
  it("filters private automatic suggestions and private quote fragments before returning a queue", async () => {
    mocked.query
      .mockResolvedValueOnce({ rows: [{ id: contact }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id,
            body: "Visible candidate",
            source_kind: "conversation_close",
            evidence: [
              { conversation_id: visibleConversation, excerpt: "Visible quote" },
            ],
          },
          {
            id: "mixed",
            body: "Hidden inference derived from multiple conversations",
            source_kind: "checkpoint",
            source_conversation_ids: [visibleConversation, hiddenConversation],
            evidence: [{ conversation_id: visibleConversation, excerpt: "Visible excerpt but private extra proof" }],
          },
          {
            id: "hidden",
            body: "Hidden candidate",
            source_kind: "checkpoint",
            evidence: [{ conversation_id: hiddenConversation, excerpt: "Hidden quote" }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: contact }] });
    mocked.visible = [{ id: visibleConversation }];
    const response = await GET(
      new NextRequest(
        `http://localhost/api/v1/ai/customer-memory/candidates?contact_id=${contact}`,
      ),
    );
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(JSON.stringify(body)).toContain("Visible quote");
    expect(JSON.stringify(body)).not.toContain("Hidden");
  });
  it("keeps read-only support from mutating a candidate", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response("read only", { status: 403 }) as never,
    );
    expect(
      (await PATCH(request({ action: "confirm", id, revision_token: "r1" }, "PATCH"))).status,
    ).toBe(403);
    expect(decideCustomerMemory).not.toHaveBeenCalled();
  });
  it("maps a freshly revoked confirmation permission to a denial", async () => {
    mocked.query.mockResolvedValue({ rows: [{ source_kind: "explicit", conversation_id: null }] });
    vi.mocked(decideCustomerMemory).mockRejectedValue(new Error("customer_memory_owner_required"));
    expect(
      (await PATCH(request({ action: "confirm", id, revision_token: "r1" }, "PATCH"))).status,
    ).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });
});
