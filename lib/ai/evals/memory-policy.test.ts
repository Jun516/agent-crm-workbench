import { describe, expect, it } from "vitest";
import { evaluateAgentRun } from "./evaluate-run";
import { resolveAgentEvalProfile } from "./profiles";
import { evaluateMemoryRecallPolicy, memoryPolicyFailure } from "./memory-policy";
import type { AgentEvalRunInput, MemoryEvaluationRecall } from "./contracts";
const receipt: MemoryEvaluationRecall = {
  recall_id: "recall",
  contact_id: "contact",
  as_of: "2026-11-13T00:00:00Z",
  coverage: "complete",
  provider_status: "unavailable",
  scope_valid: true,
  memory_ids: ["locked"],
  required_memory_ids: ["locked"],
  invalid_memory_ids: [],
  metadata_error_count: 0,
  uncertain_policy_count: 0,
  returned_count: 1,
};
const run = (recalls: MemoryEvaluationRecall[]): AgentEvalRunInput => ({
  runId: "run",
  agentId: "agent",
  task: "Check customer constraints",
  mode: "inspect",
  status: "completed",
  finalText: "Please review the customer constraints.",
  events: [],
  proposals: [],
  runtimeMessages: [],
  memoryEvaluationRecalls: recalls,
  confirmedMemoryExpectations: [
    { contactId: "contact", memoryIds: ["locked", "irrelevant"], asOf: receipt.as_of },
  ],
});
describe("native memory policy evaluation", () => {
  it("accepts local fallback and task trimming while retaining semantic review", () => {
    const report = evaluateAgentRun(run([receipt]), resolveAgentEvalProfile());
    const answer = report.dimensions.find((d) => d.key === "answer_quality")!;
    expect(answer.verdict).toBe("needs_review");
    expect(answer.findings.map((f) => f.code)).toEqual(["memory_claims_require_semantic_review"]);
  });
  it.each([
    [{ memory_ids: [], returned_count: 0, coverage: "partial" }, "memory_policy_locked_missing"],
    [{ invalid_memory_ids: ["expired"] }, "memory_policy_invalid_injected"],
    [{ scope_valid: false }, "memory_policy_scope_mismatch"],
    [{ metadata_error_count: 1 }, "memory_policy_metadata_mismatch"],
    [{ returned_count: 2 }, "memory_policy_receipt_mismatch"],
  ])("fails proven policy violations even if other answer checks pass", (change, code) => {
    const report = evaluateAgentRun(
      run([{ ...receipt, ...change } as MemoryEvaluationRecall]),
      resolveAgentEvalProfile(),
    );
    expect(report.dimensions.find((d) => d.key === "answer_quality")).toMatchObject({
      verdict: "fail",
      findings: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });
  it("does not turn human changes or incomplete coverage into invented historical certainty", () => {
    const findings = evaluateMemoryRecallPolicy([
      { ...receipt, uncertain_policy_count: 1, coverage: "partial" },
    ]);
    expect(findings.map((f) => f.code)).toContain("memory_policy_history_unverifiable");
    expect(findings.some((f) => memoryPolicyFailure(f.code))).toBe(false);
  });
  it("marks SQL existence without any receipt/observation as unproven", () => {
    const report = evaluateAgentRun(run([]), resolveAgentEvalProfile());
    expect(
      report.dimensions.find((d) => d.key === "answer_quality")?.findings.map((f) => f.code),
    ).toContain("confirmed_memory_consumption_unproven");
  });
});
