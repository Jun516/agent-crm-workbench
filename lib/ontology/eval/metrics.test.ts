import { expect, it } from "vitest";
import { summarizeCases, type ScoredCase } from "./metrics";

const base: ScoredCase = {
  id: "1",
  expectedAnswerable: true,
  response: "full",
  conceptCorrect: true,
  resultCorrect: true,
  targetCorrect: null,
  evidenceComplete: true,
  actionOutcomeCorrect: null,
  authorizationViolation: false,
  latencyMs: 10,
  inputTokens: 2,
  outputTokens: 1,
  retries: 0,
};

it("separates false refusal, false confidence and unknown measurements", () => {
  const report = summarizeCases([
    base,
    { ...base, id: "2", response: "refused", resultCorrect: null, latencyMs: 30 },
    {
      ...base,
      id: "3",
      expectedAnswerable: false,
      response: "full",
      resultCorrect: false,
      authorizationViolation: true,
      latencyMs: 20,
    },
    {
      ...base,
      id: "4",
      expectedAnswerable: false,
      response: null,
      resultCorrect: null,
      authorizationViolation: null,
      latencyMs: null,
    },
    { ...base, id: "5", response: "full", resultCorrect: false, latencyMs: null },
    { ...base, id: "6", response: "partial", resultCorrect: null, latencyMs: null },
  ]);
  expect(report.answerabilityPrecision).toEqual({ correct: 2, measured: 3 });
  expect(report.falseRefusals).toEqual({ count: 1, measured: 4 });
  expect(report.falseConfidence).toEqual({ count: 1, measured: 1 });
  expect(report.results).toEqual({ passed: 1, measured: 3, total: 6 });
  expect(report.authorization).toEqual({ violations: 1, measured: 5, total: 6 });
  expect(report.partial).toBe(1);
  expect(report.latencyMs).toEqual({ p50: 20, p95: 30, measured: 3 });
  expect(report.cost).toBe("unknown");
});
