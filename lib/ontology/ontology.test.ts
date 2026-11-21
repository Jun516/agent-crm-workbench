import { describe, expect, it } from "vitest";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { ontologyV1 } from "./catalog-v1";
import { allowedActions, validateOntology } from "./contract";
import { TOOLS_FUNIL } from "@/lib/mcp/tools/catalogo/funil";
import { crmUpdateLead } from "@/lib/mcp/tools/leads";
import {
  diffOntology,
  getOntology,
  ontologyCacheKey,
  ontologyDigest,
  ontologySnapshot,
  resolveReceipt,
} from "./versions";

const copy = () => structuredClone(ontologyV1);
const candidate = (id: string): LeadCandidate => ({
  id,
  organization_id: "synthetic-org",
  pipeline_id: "pipeline",
  status: "open",
  last_activity_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
});
describe("Ontology Lite", () => {
  it("validates the audited catalog and rejects malformed or unknown fields", () => {
    expect(validateOntology(ontologyV1).entities).toHaveLength(5);
    expect(() => validateOntology({ ...copy(), extra: true })).toThrow();
    const c = copy();
    c.entities[0]!.fields[0]!.name = "invented";
    expect(() => validateOntology(c)).toThrow(/invalid field/);
  });
  it("rejects unverified joins and conflicting terms", () => {
    const c = copy();
    c.relations[0]!.fromField = "id";
    expect(() => validateOntology(c)).toThrow(/unverified relation/);
    const n = copy();
    n.relations[0]!.nullable = false;
    expect(() => validateOntology(n)).toThrow(/unverified relation/);
    const d = copy();
    d.entities[1]!.aliases.push("CONTATO");
    expect(() => validateOntology(d)).toThrow(/term conflict/);
  });
  it("rejects cycles and undefined dependencies", () => {
    const c = copy();
    c.metrics[0]!.dependsOn = [c.metrics[1]!.id];
    c.metrics[1]!.dependsOn = [c.metrics[0]!.id];
    expect(() => validateOntology(c)).toThrow(/cycle/);
    const d = copy();
    d.metrics[0]!.dependsOn = ["missing"];
    expect(() => validateOntology(d)).toThrow(/unknown dependency/);
  });
  it("does not certify a model draft or a review of another version", () => {
    const c = copy();
    const m = c.metrics[0]!;
    m.status = "certified";
    m.origin = "model";
    m.missing = [];
    m.review = {
      reviewer: "reviewer",
      reviewedAt: "2026-01-01T00:00:00Z",
      evidence: "review-1",
      definitionVersion: "1.0.0",
    };
    expect(() => validateOntology(c)).toThrow(/model draft/);
    m.origin = "human";
    m.review.definitionVersion = "2.0.0";
    expect(() => validateOntology(c)).toThrow(/certification/);
    m.review.definitionVersion = m.version;
    expect(validateOntology(c).metrics[0]!.status).toBe("certified");
  });
  it("rejects duplicate concept IDs and blank aliases in either namespace", () => {
    const c = copy();
    c.metrics[0]!.id = c.entities[0]!.id;
    expect(() => validateOntology(c)).toThrow(/duplicate concept id/);
    for (const group of ["entities", "metrics"] as const) {
      const d = copy();
      d[group][0]!.aliases.push("  \t ");
      expect(() => validateOntology(d)).toThrow();
    }
  });
  it("requires every dependency of a certified metric to be certified and valid", () => {
    const c = copy();
    const certify = (i: number) => {
      const m = c.metrics[i]!;
      m.status = "certified";
      m.origin = "human";
      m.missing = [];
      m.review = {
        reviewer: "reviewer",
        reviewedAt: "2026-01-01T00:00:00Z",
        evidence: "review",
        definitionVersion: m.version,
      };
    };
    certify(0);
    c.metrics[0]!.dependsOn = [c.metrics[1]!.id];
    for (const status of ["proposed", "unanswerable"] as const) {
      c.metrics[1]!.status = status;
      expect(() => validateOntology(c)).toThrow(/uncertified dependency/);
    }
    certify(1);
    c.metrics[1]!.dependsOn = [c.metrics[2]!.id];
    expect(() => validateOntology(c)).toThrow(/uncertified dependency/);
    certify(2);
    expect(validateOntology(c).metrics[0]!.status).toBe("certified");
    c.metrics[2]!.review = null;
    expect(() => validateOntology(c)).toThrow(/invalid certification/);
  });
  it("binds action references to the audited MCP catalog and handler", () => {
    const binding = allowedActions[0];
    expect(TOOLS_FUNIL).toContainEqual(
      expect.objectContaining({ name: binding.capability, category: binding.risk }),
    );
    expect(crmUpdateLead.name).toBe(binding.capability);
    expect(crmUpdateLead.category).toBe(binding.risk);
    const c = copy();
    c.actions[0]!.capability = "invented_write";
    expect(() => validateOntology(c)).toThrow(/unverified action/);
    const d = copy();
    d.actions[0]!.service = "invented/service";
    expect(() => validateOntology(d)).toThrow(/unverified action/);
    const e = copy();
    e.actions[0]!.risk = "read";
    expect(() => validateOntology(e)).toThrow(/unverified action/);
  });
  it("preserves the existing resolver's zero and tied multiple outcomes", () => {
    expect(resolveActiveLeadForContact([])).toMatchObject({
      routed: false,
      reason: "no_open_lead",
    });
    expect(resolveActiveLeadForContact([candidate("a"), candidate("b")])).toMatchObject({
      routed: false,
      reason: "ambiguous_open_leads",
    });
    expect(resolveActiveLeadForContact([candidate("a")])).toMatchObject({
      routed: true,
      leadId: "a",
    });
  });
  it("pins old receipts, detects changes and invalidates keys for definition, scope and configuration", () => {
    const snapshot = ontologySnapshot(ontologyV1);
    expect(resolveReceipt(snapshot)).toEqual(ontologyV1);
    expect(ontologyDigest(ontologyV1)).toBe(ontologyDigest(getOntology("1.0.0")));
    expect(() => resolveReceipt({ ...snapshot, digest: "bad" })).toThrow(/digest/);
    expect(() => getOntology("9.0.0")).toThrow(/Unknown/);
    expect(() => validateOntology({ ...copy(), contractVersion: "2.0.0" })).toThrow();
    const newer = copy();
    newer.version = "1.0.1";
    newer.metrics[0]!.definition += " revisão";
    expect(diffOntology(ontologyV1, newer)).toContain("version");
    const key = ontologyCacheKey(ontologyV1, "scope-a", "config-1");
    expect(ontologyCacheKey(newer, "scope-a", "config-1")).not.toBe(key);
    expect(ontologyCacheKey(ontologyV1, "scope-b", "config-1")).not.toBe(key);
    expect(ontologyCacheKey(ontologyV1, "scope-a", "config-2")).not.toBe(key);
    expect(ontologyDigest(getOntology("1.0.0"))).toBe(snapshot.digest);
    expect(JSON.stringify(snapshot)).not.toMatch(/@|\+\d{8,}/);
  });
});
