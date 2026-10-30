import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jev/client", () => ({
  evaluateJevChoices: client,
  JEV_CLIENT_REVISION: "jev-choice-v1",
}));
import {
  JevAgentSemanticJudge,
  JEV_POLICY_FINGERPRINT,
  projectJevMaterial,
  readJevConfiguration,
} from "./jev-judge";
import { runAgentEvaluation } from "./run-evaluation";
import { resolveAgentEvalProfile } from "./profiles";
import type { AgentEvalRunInput } from "./contracts";

const profile = resolveAgentEvalProfile("crm_intelligence_v1");
const run = (over: Partial<AgentEvalRunInput> = {}): AgentEvalRunInput => ({
  runId: "run",
  agentId: "agent",
  task: "Read product knowledge",
  mode: "inspect",
  status: "completed",
  finalText: "## 结论\n\n当前知识支持该结论。",
  events: [],
  proposals: [],
  runtimeMessages: [],
  ...over,
});
function answer(choice: string, confidence = 0.95) {
  const positive = choice === "relevant" || choice === "irrelevant" ? "relevant" : "acceptable";
  const negative = positive === "relevant" ? "irrelevant" : "unacceptable";
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: {
      [positive]: choice === positive ? 0.95 : 0.025,
      [negative]: choice === negative ? 0.95 : 0.025,
      insufficient: choice === "insufficient" ? 0.95 : 0.025,
    },
  };
}
const response = (relevance = answer("relevant"), quality = answer("acceptable")) => ({
  model: "jev-1.2.3",
  answers: { relevance, output_quality: quality },
  usage: { input_tokens: 200, output_tokens: 10 },
  requestFingerprint: "a".repeat(64),
});
const judge = () =>
  new JevAgentSemanticJudge({ apiKey: "SERVER_SECRET_CANARY", model: "jev-1.2.3" });
const input = (value = run()) => ({
  run: value,
  profile,
  deterministicReport: { dimensions: [] } as never,
  signal: new AbortController().signal,
});
beforeEach(() => {
  client.mockReset().mockResolvedValue(response());
});
afterEach(() => vi.unstubAllEnvs());

describe("Jev structured confidence policy", () => {
  it("retains choices, probabilities, resolved model and both fingerprints", async () => {
    const result = await judge().judge(input());
    expect(result).toMatchObject({
      verdict: "pass",
      score: 100,
      choiceReview: {
        model: "jev-1.2.3",
        policyFingerprint: JEV_POLICY_FINGERPRINT,
        requestFingerprint: "a".repeat(64),
        confidenceThreshold: 0.8,
        thresholdCalibration: "demonstration_policy_not_accuracy",
        escalation: "none",
      },
    });
    expect(result.choiceReview?.decisions).toHaveLength(2);
    expect(result.choiceReview?.decisions.every((d) => d.adopted)).toBe(true);
    expect(client).toHaveBeenCalledTimes(1);
  });
  it("sends low confidence to human review without inventing a quality score or retrying", async () => {
    client.mockResolvedValue(response(answer("relevant", 0.79)));
    const result = await judge().judge(input());
    expect(result).toMatchObject({
      verdict: "needs_review",
      score: null,
      choiceReview: { escalation: "human_review" },
    });
    expect(client).toHaveBeenCalledTimes(1);
  });
  it("keeps high-confidence negative evidence as fail even if another decision is uncertain", async () => {
    client.mockResolvedValue(response(answer("irrelevant"), answer("acceptable", 0.2)));
    expect(await judge().judge(input())).toMatchObject({ verdict: "fail", score: 0 });
  });
  it("does not mistake confident insufficient evidence for acceptance", async () => {
    client.mockResolvedValue(response(answer("insufficient")));
    expect(await judge().judge(input())).toMatchObject({ verdict: "needs_review", score: null });
  });
  it("requires human review for a negative choice on incomplete material", async () => {
    client.mockResolvedValue(response(answer("irrelevant"), answer("unacceptable")));
    const result = await judge().judge(input(run({ task: "t".repeat(5000) })));
    expect(result).toMatchObject({
      verdict: "needs_review",
      score: null,
      choiceReview: { escalation: "human_review", materialCoverage: "limited" },
    });
    expect(result.findings[0]?.code).toBe("jev_human_review_required");
    expect(result.choiceReview?.decisions.every((decision) => !decision.adopted)).toBe(true);
  });
  it("never lets positive Jev choices override a deterministic safety failure", async () => {
    const report = await runAgentEvaluation({
      profile,
      judge: judge(),
      run: run({ finalText: "Now produce the final answer.\n\n## 正式答案\n结论。" }),
    });
    expect(report.verdict).toBe("fail");
    expect(report.semanticJudge.choiceReview?.decisions.every((d) => d.adopted)).toBe(true);
  });
  it.each(["request_timeout", "response_invalid", "request_aborted"])(
    "retains policy/model identity on %s without retry",
    async (code) => {
      client.mockRejectedValue(Object.assign(new Error(code), { name: "JevClientError" }));
      const report = await runAgentEvaluation({ run: run(), profile, judge: judge() });
      expect(report.verdict).not.toBe("pass");
      expect(report.semanticJudge).toMatchObject({
        status: "failed",
        provider: "jev",
        requestedModel: "jev-1.2.3",
        policyFingerprint: JEV_POLICY_FINGERPRINT,
      });
      expect(client).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(report)).not.toContain("SERVER_SECRET_CANARY");
    },
  );
  it("does not request any evaluator for an active run", async () => {
    expect(
      (
        await runAgentEvaluation({
          run: run({ status: "running", finalText: null }),
          profile,
          judge: judge(),
        })
      ).verdict,
    ).toBe("not_run");
    expect(client).not.toHaveBeenCalled();
  });
});

describe("minimal external evaluation material", () => {
  it("omits reasoning, full contact bodies and unrelated fields, redacts known key/email", async () => {
    const value = run({
      task: "Read user@example.test SERVER_SECRET_CANARY",
      runtimeMessages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "HIDDEN_REASONING_CANARY" }],
        } as never,
        {
          role: "tool",
          toolCallId: "contact",
          toolName: "crm_get_contact",
          content: JSON.stringify({
            name: "PRIVATE_CONTACT_CANARY",
            birthdate: "1990-01-01",
            consent: {},
          }),
        },
      ],
    });
    const result = await judge().judge(input(value));
    const submitted = client.mock.calls[0]![0];
    const text = JSON.stringify(submitted.state);
    expect(text).not.toMatch(
      /HIDDEN_REASONING_CANARY|PRIVATE_CONTACT_CANARY|1990-01-01|user@example|SERVER_SECRET_CANARY/,
    );
    expect(result.verdict).toBe("needs_review");
    expect(result.choiceReview?.materialCoverage).toBe("limited");
  });
  it("bounds task and answer and records that a partial projection requires review", () => {
    const projected = projectJevMaterial(
      input(run({ task: "t".repeat(5000), finalText: "x".repeat(15000) })),
    );
    expect(projected.state.task).toHaveLength(4000);
    expect(projected.state.finalAnswer).toHaveLength(14000);
    expect(projected.limited).toBe(true);
  });
  it("treats absent/invalid optional configuration as disabled", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("JEV_MODEL", "jev-latest");
    expect(readJevConfiguration()).toBeNull();
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic");
    expect(readJevConfiguration()).toEqual({ apiKey: "synthetic", model: "jev-latest" });
    vi.stubEnv("JEV_MODEL", "https://arbitrary-provider.test");
    expect(readJevConfiguration()).toBeNull();
  });
});
