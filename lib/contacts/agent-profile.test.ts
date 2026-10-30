import { describe, expect, it } from "vitest";
import { agentProfileContext } from "./agent-profile";

const now = Date.parse("2026-10-27T00:00:00Z");
const contact = {
  id: "contact-1",
  birthdate: "1990-02-01",
  tags: ["confirmed-customer"],
  consent: { profiling: { granted_at: "2026-10-01T00:00:00Z" } },
  is_anonymized: false,
  is_merged_into: null,
  is_blocked: false,
  updated_at: "2026-10-26T00:00:00Z",
};

describe("purpose-specific Agent profile projection", () => {
  it("returns only existing consented fields and their current revision", () => {
    expect(agentProfileContext(contact, now)).toMatchObject({
      status: "available",
      purpose: "profiling",
      authority: "customer_context_only",
      revision: contact.updated_at,
      consent_granted_at: contact.consent.profiling.granted_at,
      profile: { birthdate: contact.birthdate, tags: contact.tags },
    });
  });

  it.each([
    {},
    { marketing: { granted_at: "2026-10-01T00:00:00Z" } },
    { profiling: true },
    { profiling: { granted_at: "invalid" } },
    { profiling: { granted_at: "2099-01-01T00:00:00Z" } },
    { profiling: { granted_at: "2026-10-01T00:00:00Z", granted: false } },
    { profiling: { granted_at: "2026-10-01T00:00:00Z", revoked_at: "2026-10-02T00:00:00Z" } },
  ])("does not turn missing, malformed or revoked consent into a profile: %j", (consent) => {
    const result = agentProfileContext({ ...contact, consent }, now);
    expect(result).toMatchObject({ status: "not_permitted", reason: "profiling_consent_required" });
    expect(JSON.stringify(result)).not.toContain(contact.birthdate);
    expect(result).not.toHaveProperty("profile");
  });

  it.each([{ is_anonymized: true }, { is_merged_into: "surviving-contact" }, { is_blocked: true }])(
    "privacy eligibility takes precedence over an old grant: %j",
    (change) => {
      expect(agentProfileContext({ ...contact, ...change }, now)).toMatchObject({
        status: "unavailable",
        reason: "contact_ineligible",
      });
    },
  );
});
