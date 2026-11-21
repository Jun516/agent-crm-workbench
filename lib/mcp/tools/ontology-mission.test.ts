import { describe, expect, it } from "vitest";
import { ontologyDescribeOutcome } from "./ontology";

function context(run: Record<string, unknown> | null, mission: Record<string, unknown> | null) {
  const filters: Array<[string, string, unknown]> = [];
  return {
    filters,
    ctx: {
      organizationId: "org-a", ontologyRuntime: { workbenchRunId: "run-a" },
      supabase: { from(table: string) {
        const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([table, key, value]); return query; },
          maybeSingle: async () => ({ data: table === "ai_workbench_runs" ? run : mission, error: null }) };
        return query;
      } },
    } as never,
  };
}

describe("Mission outcome description", () => {
  it("reads only the Mission attached to the trusted Run and scopes both reads", async () => {
    const fixture = context({ mission_id: "mission-a" }, { acceptance_contract: { revision: 1, checks: [{ kind: "lead_status", equals: "won" }] } });
    const result = await ontologyDescribeOutcome.handler({}, fixture.ctx);
    expect(result).toMatchObject({ status: "supported", outcome: { checks: [{ kind: "lead_status", expected: "won" }], businessOutcomeVerified: false } });
    expect(fixture.filters).toContainEqual(["ai_workbench_runs", "organization_id", "org-a"]);
    expect(fixture.filters).toContainEqual(["ai_missions", "organization_id", "org-a"]);
    expect(fixture.filters).toContainEqual(["ai_missions", "id", "mission-a"]);
  });
  it("fails closed without a bound Mission or with an invalid contract", async () => {
    expect(await ontologyDescribeOutcome.handler({}, context({ mission_id: null }, null).ctx)).toMatchObject({ status: "unanswerable" });
    expect(await ontologyDescribeOutcome.handler({}, context({ mission_id: "mission-a" }, { acceptance_contract: { revision: 2 } }).ctx)).toMatchObject({ status: "unanswerable" });
  });
});
