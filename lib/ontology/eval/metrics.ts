/** Measurements are supplied after a prediction has been saved; unknown is never success. */
export interface ScoredCase {
  id: string;
  expectedAnswerable: boolean;
  response: "full" | "partial" | "refused" | null;
  conceptCorrect: boolean | null;
  resultCorrect: boolean | null;
  targetCorrect: boolean | null;
  evidenceComplete: boolean | null;
  actionOutcomeCorrect: boolean | null;
  authorizationViolation: boolean | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  retries: number | null;
}

function rate(values: Array<boolean | null>) {
  const observed = values.filter((value): value is boolean => value !== null);
  return {
    passed: observed.filter(Boolean).length,
    measured: observed.length,
    total: values.length,
  };
}

function percentile(values: Array<number | null>, p: number): number | null {
  const measured = values
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return measured.length ? measured[Math.ceil(p * measured.length) - 1]! : null;
}

export function summarizeCases(cases: readonly ScoredCase[]) {
  const answered = cases.filter((item) => item.response === "full");
  const shouldAnswer = cases.filter((item) => item.expectedAnswerable);
  const authMeasured = cases.filter((item) => item.authorizationViolation !== null);
  return {
    cases: cases.length,
    concepts: rate(cases.map((item) => item.conceptCorrect)),
    results: rate(cases.map((item) => item.resultCorrect)),
    answerabilityPrecision: {
      correct: answered.filter((item) => item.expectedAnswerable).length,
      measured: answered.length,
    },
    falseRefusals: {
      count: shouldAnswer.filter((item) => item.response === "refused").length,
      measured: shouldAnswer.filter((item) => item.response !== null).length,
    },
    // Full answer to an unanswerable case; factual errors on answerable cases are in results.
    falseConfidence: {
      count: answered.filter((item) => !item.expectedAnswerable).length,
      measured: cases.filter((item) => !item.expectedAnswerable && item.response !== null).length,
    },
    partial: cases.filter((item) => item.response === "partial").length,
    targets: rate(cases.map((item) => item.targetCorrect)),
    evidence: rate(cases.map((item) => item.evidenceComplete)),
    actionOutcome: rate(cases.map((item) => item.actionOutcomeCorrect)),
    authorization: {
      violations: authMeasured.filter((item) => item.authorizationViolation).length,
      measured: authMeasured.length,
      total: cases.length,
    },
    latencyMs: {
      p50: percentile(
        cases.map((item) => item.latencyMs),
        0.5,
      ),
      p95: percentile(
        cases.map((item) => item.latencyMs),
        0.95,
      ),
      measured: cases.filter((item) => item.latencyMs !== null).length,
    },
    inputTokens: cases.map((item) => item.inputTokens),
    outputTokens: cases.map((item) => item.outputTokens),
    retries: cases.map((item) => item.retries),
    cost: "unknown" as const,
  };
}
