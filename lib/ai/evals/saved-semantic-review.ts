import { createHash } from "node:crypto";
import type { AgentEvalReport } from "./contracts";
import {
  JEV_POLICY_FINGERPRINT,
  JEV_RUBRIC_REVISION,
  jevEvaluatorKey,
  jevModelIsPinned,
} from "./jev-judge";

export function matchingSavedSemanticReview(
  rows: Array<{ report: unknown; input_fingerprint: string }>,
  material: {
    runId: string;
    profileKey: string;
    profileRevision: number;
    baseFingerprint: string;
    rubricRevision: number;
  },
): AgentEvalReport | null {
  for (const row of rows) {
    const report = row.report as AgentEvalReport | null;
    const judge = report?.semanticJudge;
    if (
      report?.runId !== material.runId ||
      report?.profileKey !== material.profileKey ||
      report?.profileRevision !== material.profileRevision ||
      judge?.status !== "completed" ||
      judge.rubricRevision !== material.rubricRevision ||
      typeof judge.judgeId !== "string"
    )
      continue;
    const prefix = `workbench_semantic_v${material.rubricRevision}:`;
    if (!judge.judgeId.startsWith(prefix)) continue;
    const evaluator = `semantic:v${material.rubricRevision}:${judge.judgeId.slice(prefix.length)}`;
    const fingerprint = createHash("sha256")
      .update(`${material.baseFingerprint}:${evaluator}`)
      .digest("hex");
    if (row.input_fingerprint === fingerprint) return report;
  }
  return null;
}

/** Jev history is displayed separately; it can never masquerade as the LLM Judge. */
export function matchingSavedJevReview(
  rows: Array<{ report: unknown; input_fingerprint: string }>,
  material: { runId: string; profileKey: string; profileRevision: number; baseFingerprint: string },
): AgentEvalReport | null {
  for (const row of rows) {
    const report = row.report as AgentEvalReport | null;
    const judge = report?.semanticJudge;
    const choice = judge?.choiceReview;
    if (
      report?.runId === material.runId &&
      report?.profileKey === material.profileKey &&
      report?.profileRevision === material.profileRevision &&
      judge?.status === "failed" &&
      judge.provider === "jev" &&
      judge.policyFingerprint === JEV_POLICY_FINGERPRINT &&
      typeof judge.requestedModel === "string" &&
      typeof judge.attemptId === "string" &&
      judge.rubricRevision === JEV_RUBRIC_REVISION
    ) {
      const expected = createHash("sha256")
        .update(
          `${material.baseFingerprint}:${jevEvaluatorKey(judge.requestedModel, judge.requestedModel, judge.authorizationFingerprint)}:failed:${judge.attemptId}`,
        )
        .digest("hex");
      if (row.input_fingerprint === expected) return report;
      continue;
    }
    if (
      report?.runId !== material.runId ||
      report?.profileKey !== material.profileKey ||
      report?.profileRevision !== material.profileRevision ||
      judge?.status !== "completed" ||
      judge.rubricRevision !== JEV_RUBRIC_REVISION ||
      choice?.provider !== "jev" ||
      choice.policyFingerprint !== JEV_POLICY_FINGERPRINT ||
      typeof choice.model !== "string" ||
      typeof choice.requestedModel !== "string" ||
      typeof choice.attemptId !== "string" ||
      !/^[a-f0-9]{64}$/.test(choice.requestFingerprint) ||
      !/^[a-f0-9]{64}$/.test(choice.authorizationFingerprint) ||
      judge.judgeId !== `workbench_jev_v${JEV_RUBRIC_REVISION}:${choice.model}`
    )
      continue;
    const evaluator =
      jevEvaluatorKey(choice.model, choice.requestedModel, choice.authorizationFingerprint) +
      (jevModelIsPinned(choice.requestedModel) ? "" : `:attempt:${choice.attemptId}`);
    const fingerprint = createHash("sha256")
      .update(`${material.baseFingerprint}:${evaluator}`)
      .digest("hex");
    if (row.input_fingerprint === fingerprint) return report;
  }
  return null;
}
