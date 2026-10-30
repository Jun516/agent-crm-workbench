import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEphemeralTokenScopes, mintEphemeralToken } from "./mcp_token";
import { isMcpToolGranted } from "@/lib/mcp/tool-grants";

const state = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: state.insert }),
  }),
}));

beforeEach(() => {
  state.insert.mockReset();
  state.insert.mockImplementation(() => ({
    select: () => ({
      single: async () => ({
        data: { id: "token-a", expires_at: "2026-10-27T00:05:00Z" },
        error: null,
      }),
    }),
  }));
});

describe("persisted runtime token manifest", () => {
  it("stores the same narrowed scopes used by the in-process bridge", async () => {
    const input = {
      organizationId: "org-a",
      runId: "run-a",
      versionCreatedBy: "user-a",
      readOnly: true,
      toolIds: ["crm_get_contact"],
    };
    const token = await mintEphemeralToken(input);
    const row = state.insert.mock.calls[0]![0];
    expect(row.organization_id).toBe("org-a");
    expect(row.scopes).toEqual(buildEphemeralTokenScopes(input));
    expect(row.scopes).not.toContain("mcp:write");
    expect(isMcpToolGranted(row.scopes, "crm_get_contact")).toBe(true);
    expect(isMcpToolGranted(row.scopes, "crm_create_lead")).toBe(false);
    expect(row.token_hash).not.toContain(token.plaintext);
    expect(JSON.stringify(row)).not.toContain(token.plaintext);
  });

  it("missing/empty runtime lists fail closed instead of granting the catalog", () => {
    expect(isMcpToolGranted(buildEphemeralTokenScopes({ runId: "r" }), "crm_get_contact")).toBe(
      false,
    );
    expect(
      isMcpToolGranted(buildEphemeralTokenScopes({ runId: "r", toolIds: [] }), "crm_get_contact"),
    ).toBe(false);
  });
});
