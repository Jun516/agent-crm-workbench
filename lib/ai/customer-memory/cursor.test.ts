import { describe, expect, it } from "vitest";
import { encodeMemoryCursor, decodeMemoryCursor } from "./cursor";
const binding = {
  org: "org-1",
  actor: "actor-1",
  contact: "contact-1",
  resource: "candidates",
  filter: "pending",
};
const position = { rank: 0, at: "2026-11-13T00:00:00.123456Z", id: "private-position-id" };
describe("private memory-list cursor", () => {
  it("preserves microseconds without exposing skipped private IDs or dates", () => {
    const token = encodeMemoryCursor(position, binding, "fixture-secret");
    expect(decodeMemoryCursor(token, binding, "fixture-secret")).toEqual(position);
    expect(Buffer.from(token, "base64url").toString()).not.toContain(position.id);
    expect(Buffer.from(token, "base64url").toString()).not.toContain(position.at);
  });
  it.each([
    { org: "org-2" },
    { actor: "actor-2" },
    { contact: "contact-2" },
    { resource: "status" },
    { filter: "all" },
  ])("rejects cursor reuse across authorization or filter boundaries", (change) => {
    const token = encodeMemoryCursor(position, binding, "fixture-secret");
    expect(() => decodeMemoryCursor(token, { ...binding, ...change }, "fixture-secret")).toThrow(
      "memory_cursor_invalid",
    );
  });
  it("rejects byte tampering, wrong keys and malformed encodings", () => {
    const token = encodeMemoryCursor(position, binding, "fixture-secret");
    const bytes = Buffer.from(token, "base64url");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    for (const value of [bytes.toString("base64url"), token + "=", "junk"])
      expect(() => decodeMemoryCursor(value, binding, "fixture-secret")).toThrow(
        "memory_cursor_invalid",
      );
    expect(() => decodeMemoryCursor(token, binding, "another-key")).toThrow(
      "memory_cursor_invalid",
    );
  });
});
