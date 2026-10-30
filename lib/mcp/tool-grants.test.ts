import { describe, expect, it } from "vitest";
import { ensureRole, ensureScope, ensureToolGrant } from "./auth";
import { buildToolGrantScopes, isMcpToolGranted, MCP_TOOL_MANIFEST_SCOPE } from "./tool-grants";

describe("exact MCP tool manifest", () => {
  it("deduplicates and sorts the exact names", () => {
    expect(buildToolGrantScopes(["crm_get_contact", "crm_get_lead", "crm_get_contact"])).toEqual([
      MCP_TOOL_MANIFEST_SCOPE,
      "mcp:tool:crm_get_contact",
      "mcp:tool:crm_get_lead",
    ]);
  });

  it("empty or malformed explicit manifests never fall back to broad access", () => {
    expect(isMcpToolGranted([MCP_TOOL_MANIFEST_SCOPE], "crm_get_contact")).toBe(false);
    expect(isMcpToolGranted(["mcp:tool:"], "crm_get_contact")).toBe(false);
    expect(() => buildToolGrantScopes(["crm_get_contact*"])).toThrow("invalid_mcp_tool_grant");
  });

  it("uses exact equality, not a prefix or wildcard match", () => {
    const scopes = buildToolGrantScopes(["crm_get_contact"]);
    expect(isMcpToolGranted(scopes, "crm_get_contact")).toBe(true);
    expect(isMcpToolGranted(scopes, "crm_get_contacts")).toBe(false);
    expect(isMcpToolGranted(scopes, "crm_delete_contact")).toBe(false);
    expect(() => ensureToolGrant(scopes, "crm_delete_contact")).toThrow("does not grant tool");
  });

  it("retains legacy scope behavior without replacing role/read-write checks", () => {
    expect(isMcpToolGranted(["mcp:read"], "crm_get_contact")).toBe(true);
    const exact = buildToolGrantScopes(["crm_create_lead"]);
    expect(() => ensureToolGrant(exact, "crm_create_lead")).not.toThrow();
    expect(() => ensureScope(exact, "mcp:write")).toThrow("required scope");
    expect(() => ensureRole("viewer", "manager")).toThrow("insufficient");
  });
});
