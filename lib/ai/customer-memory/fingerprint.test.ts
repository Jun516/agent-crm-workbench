import { describe, expect, it } from "vitest";
import { candidateFingerprint } from "./candidates";
const fingerprint = (body: string) =>
  candidateFingerprint({ memory_type: "commercial_preference", body });
describe("conservative candidate identity", () => {
  it("preserves decimals, signs and negation rather than merging different commercial constraints", () => {
    expect(fingerprint("Discount ceiling 1.5%")).not.toBe(fingerprint("Discount ceiling 15%"));
    expect(fingerprint("Balance +10")).not.toBe(fingerprint("Balance -10"));
    expect(fingerprint("Do not phone")).not.toBe(fingerprint("Do phone"));
  });
  it("normalizes only harmless case/spacing and sentence punctuation", () => {
    expect(fingerprint("  Email   preferred. ")).toBe(fingerprint("email preferred"));
  });
  it("does not merge temporary requests that expire at different times", () => {
    const base = {
      memory_type: "temporary_request" as const,
      body: "This promotion",
      attribute_key: "purchase.trial",
      attribute_value: "small batch",
    };
    expect(candidateFingerprint({ ...base, ttl_expires_at: "2026-12-01T00:00:00Z" })).not.toBe(
      candidateFingerprint({ ...base, ttl_expires_at: "2027-01-01T00:00:00Z" }),
    );
  });
});
