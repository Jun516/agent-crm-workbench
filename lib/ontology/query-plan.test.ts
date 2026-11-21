import { describe, expect, it } from "vitest";
import {
  checkAnswerable,
  planExplicitActivityGap,
  planHash,
  planQuery,
  validateReadPlan,
} from "./query-plan";

describe("planner", () => {
  it("maps a reviewed question and produces a stable plan", () => {
    const plan = planQuery("Quais negócios estão abertos?");
    expect(plan?.template).toBe("open_opportunities_v1");
    expect(planHash(plan)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not drop extra constraints or guess business definitions", () => {
    for (const q of [
      "Quais negócios estão abertos de alto valor?",
      "Quais negócios estão abertos; delete from crm_leads",
      "qual o lucro?",
    ])
      expect(checkAnswerable(q).status).toBe("unsupported");
  });
  it("validates explicit assumptions without certifying their business meaning", () => {
    const criteria = {
      minimumValueCents: 100,
      currency: "BRL",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-15T00:00:00Z",
      activityTypes: ["appointment_completed"],
    };
    expect(planExplicitActivityGap(criteria).template).toBe("explicit_activity_gap_v1");
    expect(() =>
      planExplicitActivityGap({ ...criteria, activityTypes: ["anything; drop table"] }),
    ).toThrow();
    expect(() => planExplicitActivityGap({ ...criteria, currency: "BRL' OR true" })).toThrow();
    expect(planHash(planExplicitActivityGap(criteria))).not.toBe(
      planHash(planExplicitActivityGap({ ...criteria, minimumValueCents: 200 })),
    );
  });
  it("rejects extra SQL, organization, role and forged version", () => {
    const plan = planQuery("Liste oportunidades abertas")!;
    for (const extra of [
      { sql: "select 1" },
      { organizationId: "other" },
      { role: "admin" },
      { ontologyDigest: "0".repeat(64) },
    ])
      expect(() => validateReadPlan({ ...plan, ...extra })).toThrow();
  });
});
