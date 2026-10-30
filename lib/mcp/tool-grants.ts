/**
 * Exact MCP tool grants carried by an existing api_tokens.scopes array.
 * A manifest narrows role + read/write scopes; it never replaces either gate.
 * Tokens issued before this convention retain their existing coarse scopes.
 */
export const MCP_TOOL_MANIFEST_SCOPE = "mcp:tools:restricted";
export const MCP_TOOL_SCOPE_PREFIX = "mcp:tool:";

export function buildToolGrantScopes(toolIds: readonly string[]): string[] {
  const unique = [...new Set(toolIds)];
  if (unique.some((id) => !/^[a-z][a-z0-9_]{0,127}$/.test(id))) {
    throw new Error("invalid_mcp_tool_grant");
  }
  return [MCP_TOOL_MANIFEST_SCOPE, ...unique.sort().map((id) => `${MCP_TOOL_SCOPE_PREFIX}${id}`)];
}

export function isMcpToolGranted(scopes: readonly string[], toolName: string): boolean {
  const restricted =
    scopes.includes(MCP_TOOL_MANIFEST_SCOPE) ||
    scopes.some((scope) => scope.startsWith(MCP_TOOL_SCOPE_PREFIX));
  return !restricted || scopes.includes(`${MCP_TOOL_SCOPE_PREFIX}${toolName}`);
}
