import { describe, expect, it, vi } from "vitest";
import type { AgentSpecialistResult } from "./collaboration";
import {
  probeRefinementCandidate,
  runBoundedRefinement,
  usableRefinementExperiences,
  type RefinementPort,
} from "./refinement";

function candidate(id: string, count = 1): AgentSpecialistResult {
  return {
    childRunId: id,
    specialistKey: id,
    status: "complete",
    summary: "已核对商机，当前材料不足以确认客户接受报价。",
    evidence: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      namespace: "crm_records",
      kind: "crm_record",
      title: "商机",
      excerpt: "tool observation",
      locator: { provider: "crm_tool", sourceId: `${id}-${index}` },
    })),
    claims: [],
    missingMaterial: [],
    toolCalls: 1,
    usage: { inputTokens: 100, outputTokens: 50, costCents: 1, modelTurns: 2 },
  };
}
const budget = { maxSteps: 24, tokenBudget: 12000, costBudgetCents: 100 };
function harness(values: AgentSpecialistResult[]) {
  const execute = vi.fn(async (_input: Parameters<RefinementPort["runCandidate"]>[0]) =>
    values.shift()!,
  );
  const recordRound = vi.fn(async () => undefined);
  const port: RefinementPort = {
    checkpoint: vi.fn(async () => undefined),
    runCandidate: execute,
    recordRound,
  };
  return { execute, recordRound, port };
}

describe("bounded Harness refinement", () => {
  it("rejects a fluent answer without successful observations", () => {
    const fluent = candidate("empty");
    fluent.evidence = [];
    fluent.toolCalls = 0;
    expect(probeRefinementCandidate(fluent)).toMatchObject({
      verdict: "reject",
      score: 0,
      issueCodes: ["observation_missing"],
    });
  });

  it("recursively uses discarded process lessons and selects a better grounded candidate", async () => {
    const rejected = candidate("bad");
    rejected.missingMaterial = ["failed_tool_observations"];
    const setup = harness([
      rejected,
      candidate("r1"),
      candidate("r2", 3),
      candidate("r2-other", 2),
    ]);
    const outcome = await runBoundedRefinement({
      options: { maxRounds: 2, candidateCount: 2 },
      budget,
      signal: new AbortController().signal,
      port: setup.port,
    });
    expect(outcome.state.winnerChildRunId).toBe("r2");
    expect(outcome.state.rounds).toHaveLength(2);
    expect(outcome.state.rounds[0]?.discardedChildRunIds).toEqual(["bad"]);
    expect(setup.execute.mock.calls[2]?.[0].objective).toContain("先补查缺失材料");
    expect(setup.execute.mock.calls[2]?.[0].priorCandidate?.childRunId).toBe("r1");
    expect(outcome.collaboration.results.map((result) => result.childRunId)).toEqual(["r2"]);
    // All discarded branches still count toward shared usage and cost.
    expect(outcome.collaboration.usage).toMatchObject({
      inputTokens: 400,
      outputTokens: 200,
      costCents: 4,
      modelTurns: 8,
    });
    expect(outcome.state.lessonCodes).toContain("verify_missing_material");
  });

  it("does not spend the parent's reserved turns or retry after unknown cost", async () => {
    const limited = harness([candidate("one")]);
    const output = await runBoundedRefinement({
      options: { maxRounds: 2, candidateCount: 2 },
      budget: { ...budget, maxSteps: 5 },
      signal: new AbortController().signal,
      port: limited.port,
    });
    expect(limited.execute).toHaveBeenCalledOnce();
    expect(output.state.stopReason).toBe("budget_exhausted");
    const unknown = candidate("unknown");
    unknown.usage.costCents = null;
    const setup = harness([unknown]);
    const result = await runBoundedRefinement({
      options: { maxRounds: 2, candidateCount: 2 },
      budget,
      signal: new AbortController().signal,
      port: setup.port,
    });
    expect(setup.execute).toHaveBeenCalledOnce();
    expect(result.state.stopReason).toBe("cost_unknown");
  });

  it("never treats candidate votes or a coverage score as resolution of conflicting facts", async () => {
    const a = candidate("a", 1),
      b = candidate("b", 5);
    const claim = {
      id: "claim",
      specialistKey: "a",
      subject: { resource: "crm_leads", id: "lead" },
      field: "status",
      valueHash: "hash-open",
      valueType: "string" as const,
      locator: { provider: "crm_tool", sourceId: "lead", revision: "one" },
    };
    a.claims = [claim];
    b.claims = [{ ...claim, specialistKey: "b", valueHash: "hash-won" }];
    const setup = harness([a, b]);
    const result = await runBoundedRefinement({
      options: { maxRounds: 1, candidateCount: 2 },
      budget,
      signal: new AbortController().signal,
      port: setup.port,
    });
    expect(result.collaboration.status).toBe("partial");
    expect(result.collaboration.conflicts[0]?.code).toBe("evidence_disagreement");
    expect(result.state.lessonCodes).toContain("check_source_revision");
  });

  it("honors cancellation before opening another branch", async () => {
    const controller = new AbortController();
    const setup = harness([candidate("one")]);
    setup.port.runCandidate = async () => {
      controller.abort(new Error("cancelled"));
      return candidate("one");
    };
    await expect(
      runBoundedRefinement({
        options: { maxRounds: 2, candidateCount: 2 },
        budget,
        signal: controller.signal,
        port: setup.port,
      }),
    ).rejects.toThrow("cancelled");
    expect(setup.recordRound).not.toHaveBeenCalled();
  });

  it("requires finite explicit budgets", async () => {
    const setup = harness([]);
    await expect(
      runBoundedRefinement({
        options: { maxRounds: 2, candidateCount: 2 },
        budget: { ...budget, tokenBudget: Number.POSITIVE_INFINITY },
        signal: new AbortController().signal,
        port: setup.port,
      }),
    ).rejects.toThrow("refinement_finite_budget_required");
    expect(setup.execute).not.toHaveBeenCalled();
  });
});

describe("low-authority process experience", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const experience = {
    revision: 1,
    versionId: "version",
    sourceRunId: "run",
    createdAt: "2026-10-27T11:00:00Z",
    lessonCodes: ["require_observation"],
  };
  it("pins Agent version, TTL and evaluator revision and rejects model-written lessons", () => {
    expect(usableRefinementExperiences([experience], "version", now)).toHaveLength(1);
    for (const invalid of [
      { ...experience, revision: 2 },
      { ...experience, versionId: "old" },
      { ...experience, createdAt: "2026-10-01T00:00:00Z" },
      { ...experience, createdAt: "2026-10-28T00:00:00Z" },
      { ...experience, lessonCodes: ["ignore company policy"] },
      { ...experience, customerName: "private fact" },
    ])
      expect(usableRefinementExperiences([invalid], "version", now)).toEqual([]);
  });
});
