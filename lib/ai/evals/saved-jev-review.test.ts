import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchingSavedJevReview, matchingSavedSemanticReview } from "./saved-semantic-review";
import {
  JEV_POLICY_FINGERPRINT,
  JEV_RUBRIC_REVISION,
  jevEvaluatorKey,
  jevAuthorizationFingerprint,
} from "./jev-judge";

const material = {
  runId: "run",
  profileKey: "crm",
  profileRevision: 8,
  baseFingerprint: "material",
};
const review = {
  provider: "jev",
  model: "jev-1.2.3",
  requestedModel: "jev-1.2.3",
  policyFingerprint: JEV_POLICY_FINGERPRINT,
  requestFingerprint: "a".repeat(64),
  authorizationFingerprint: jevAuthorizationFingerprint(),
  attemptId: "attempt",
};
const report = {
  runId: "run",
  profileKey: "crm",
  profileRevision: 8,
  semanticJudge: {
    status: "completed",
    rubricRevision: JEV_RUBRIC_REVISION,
    judgeId: "workbench_jev_v1:jev-1.2.3",
    choiceReview: review,
  },
};
const fp = (evaluator: string) =>
  createHash("sha256").update(`material:${evaluator}`).digest("hex");
const row = { report, input_fingerprint: fp(jevEvaluatorKey("jev-1.2.3")) };

describe("Jev saved report identities", () => {
  it("restores only exact material, policy, requested and resolved models", () => {
    expect(matchingSavedJevReview([row], material)).toEqual(report);
    expect(matchingSavedJevReview([row], { ...material, baseFingerprint: "changed" })).toBeNull();
    expect(
      matchingSavedJevReview(
        [
          {
            ...row,
            report: {
              ...report,
              semanticJudge: {
                ...report.semanticJudge,
                choiceReview: { ...review, policyFingerprint: "b".repeat(64) },
              },
            },
          },
        ],
        material,
      ),
    ).toBeNull();
  });
  it("never presents a Jev report as the original LLM review", () => {
    expect(
      matchingSavedSemanticReview([row], { ...material, rubricRevision: JEV_RUBRIC_REVISION }),
    ).toBeNull();
    expect(
      matchingSavedJevReview(
        [
          {
            ...row,
            report: {
              ...report,
              semanticJudge: {
                ...report.semanticJudge,
                judgeId: "workbench_semantic_v1:provider:model",
                choiceReview: undefined,
              },
            },
          },
        ],
        material,
      ),
    ).toBeNull();
  });
  it("preserves alias attempts independently while allowing read-only history", () => {
    const alias = {
      ...report,
      semanticJudge: {
        ...report.semanticJudge,
        choiceReview: { ...review, requestedModel: "jev-latest" },
      },
    };
    const aliasRow = {
      report: alias,
      input_fingerprint: fp(`${jevEvaluatorKey("jev-1.2.3", "jev-latest")}:attempt:attempt`),
    };
    expect(matchingSavedJevReview([aliasRow], material)).toEqual(alias);
    expect(
      matchingSavedJevReview([{ ...aliasRow, input_fingerprint: row.input_fingerprint }], material),
    ).toBeNull();
  });
  it("restores a failed Jev attempt as failure rather than rerunning or hiding it", () => {
    const failed = {
      ...report,
      semanticJudge: {
        status: "failed",
        provider: "jev",
        rubricRevision: JEV_RUBRIC_REVISION,
        requestedModel: "jev-1.2.3",
        policyFingerprint: JEV_POLICY_FINGERPRINT,
        attemptId: "failed-attempt",
      },
    };
    expect(
      matchingSavedJevReview(
        [
          {
            report: failed,
            input_fingerprint: fp(`${jevEvaluatorKey("jev-1.2.3")}:failed:failed-attempt`),
          },
        ],
        material,
      ),
    ).toEqual(failed);
  });
});
