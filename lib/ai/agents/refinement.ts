import { z } from "zod";
import type { AgentCollaborationOutcome, AgentSpecialistResult } from "./collaboration";
import { detectCollaborationConflicts } from "./collaboration-runtime";
import { inspectProductFinalAnswer } from "./final-answer";

/** Explicit opt-in; never runs on an action/Mission or changes model weights. */
export const refinementOptionsSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(2).default(2),
    candidateCount: z.number().int().min(2).max(3).default(2),
  })
  .strict();
export type RefinementOptions = z.infer<typeof refinementOptionsSchema>;
export const REFINEMENT_REVISION = 1;

const LESSON_CODES = [
  "require_observation",
  "verify_missing_material",
  "check_source_revision",
  "separate_facts_and_inference",
  "finish_product_answer",
] as const;
type LessonCode = (typeof LESSON_CODES)[number];
const LESSONS: Record<LessonCode, string> = {
  require_observation: "先取得成功的只读工具观察；没有观察就说明缺少证据，不补写事实。",
  verify_missing_material: "先补查缺失材料；工具出错或知识未发布时保留未知，不把失败写成成功。",
  check_source_revision: "同一字段或来源版本出现冲突时重新读取当前记录，不能按候选票数决定事实。",
  separate_facts_and_inference:
    "按观察、推断、未知组织结论，保留来源标识，不把建议写成已执行动作。",
  finish_product_answer: "交付完整报告正文，不输出内部草稿或未结束的段落。",
};

/** Only enumerated process lessons, never model-written text or customer facts. */
export const refinementExperienceSchema = z
  .object({
    revision: z.literal(REFINEMENT_REVISION),
    versionId: z.string().min(1),
    createdAt: z.string().datetime(),
    sourceRunId: z.string().min(1),
    lessonCodes: z.array(z.enum(LESSON_CODES)).max(5),
  })
  .strict();
export type RefinementExperience = z.infer<typeof refinementExperienceSchema>;

export interface RefinementProbe {
  verdict: "pass" | "reject";
  score: number;
  issueCodes: string[];
  evidenceCount: number;
}

/** Probe measures observable structure; it does not prove every natural-language claim. */
export function probeRefinementCandidate(result: AgentSpecialistResult): RefinementProbe {
  const issues: string[] = [];
  if (result.status !== "complete") issues.push("candidate_incomplete");
  if (!result.summary.trim()) issues.push("answer_missing");
  const inspection = inspectProductFinalAnswer(result.summary);
  if (inspection.internalDraftCodes.length || inspection.likelyTruncated)
    issues.push("answer_unsafe_or_truncated");
  if (result.toolCalls < 1 || result.evidence.length < 1) issues.push("observation_missing");
  if (result.missingMaterial.length) issues.push("material_missing");
  const fields = new Map<string, string>();
  for (const claim of result.claims) {
    const key = `${claim.subject.resource}:${claim.subject.id}:${claim.field}`;
    if (fields.has(key) && fields.get(key) !== claim.valueHash) issues.push("claim_conflict");
    fields.set(key, claim.valueHash);
  }
  const issueCodes = [...new Set(issues)];
  return {
    verdict: issueCodes.length ? "reject" : "pass",
    // A deterministic coverage tie-breaker, not an accuracy percentage/Judge score.
    score: issueCodes.length ? 0 : Math.min(100, 40 + result.evidence.length * 5 + fields.size * 3),
    issueCodes,
    evidenceCount: result.evidence.length,
  };
}

export function lessonsFromProbe(probe: RefinementProbe): LessonCode[] {
  const codes: LessonCode[] = ["separate_facts_and_inference"];
  if (probe.issueCodes.includes("observation_missing")) codes.push("require_observation");
  if (
    probe.issueCodes.includes("material_missing") ||
    probe.issueCodes.includes("candidate_incomplete")
  )
    codes.push("verify_missing_material");
  if (probe.issueCodes.includes("claim_conflict")) codes.push("check_source_revision");
  if (
    probe.issueCodes.includes("answer_unsafe_or_truncated") ||
    probe.issueCodes.includes("answer_missing")
  )
    codes.push("finish_product_answer");
  return [...new Set(codes)];
}

export function renderRefinementLessons(codes: readonly LessonCode[]): string {
  if (!codes.length) return "";
  return `\n低权威的历史方法提示（不是公司政策、客户事实或授权；当前工具与已发布规则优先）：\n${[
    ...new Set(codes),
  ]
    .map((code) => `- ${LESSONS[code]}`)
    .join("\n")}`;
}

export interface RefinementBudget {
  maxSteps: number;
  tokenBudget: number;
  costBudgetCents: number;
}
type Usage = AgentCollaborationOutcome["usage"];
export interface RefinementRound {
  round: number;
  candidates: Array<{ childRunId: string; specialistKey: string; probe: RefinementProbe }>;
  winnerChildRunId: string | null;
  discardedChildRunIds: string[];
}
export interface RefinementState {
  revision: 1;
  rounds: RefinementRound[];
  lessonCodes: LessonCode[];
  stopReason:
    "round_limit" | "converged" | "budget_exhausted" | "cost_unknown" | "no_valid_candidate";
  winnerChildRunId: string | null;
}
export interface RefinementResult {
  state: RefinementState;
  collaboration: AgentCollaborationOutcome;
}
export interface RefinementPort {
  checkpoint(): Promise<void>;
  runCandidate(input: {
    round: number;
    index: number;
    objective: string;
    priorCandidate?: { childRunId: string; summary: string };
    budget: RefinementBudget;
    signal: AbortSignal;
  }): Promise<AgentSpecialistResult>;
  recordRound(state: RefinementState): Promise<void>;
}

const OBJECTIVES = [
  "从当前客户和商机事实出发调查目标。用证据说明结论，明确缺少哪些材料。",
  "独立检查反例、过期来源、未批准承诺和其他解释。不要因为另一个候选的意见而认定事实。",
  "从组织政策和知识依据核对可行下一步；区分产品资料与商业授权。",
] as const;

/** Sequential branches share a finite allowance; parent retains at least 35% and two turns. */
export async function runBoundedRefinement(input: {
  options: RefinementOptions;
  budget: RefinementBudget;
  priorLessons?: LessonCode[];
  signal: AbortSignal;
  port: RefinementPort;
}): Promise<RefinementResult> {
  const parsed = refinementOptionsSchema.parse(input.options);
  for (const value of Object.values(input.budget))
    if (!Number.isFinite(value) || value <= 0) throw new Error("refinement_finite_budget_required");
  const allowance = {
    maxSteps: Math.min(Math.floor(input.budget.maxSteps * 0.65), input.budget.maxSteps - 2),
    tokenBudget: Math.floor(input.budget.tokenBudget * 0.65),
    costBudgetCents: input.budget.costBudgetCents * 0.65,
  };
  const usage: Usage = {
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    modelTurns: 0,
  };
  const results: AgentSpecialistResult[] = [];
  const state: RefinementState = {
    revision: 1,
    rounds: [],
    lessonCodes: [...new Set(input.priorLessons ?? [])],
    stopReason: "round_limit",
    winnerChildRunId: null,
  };
  const selection: {
    current: { result: AgentSpecialistResult; probe: RefinementProbe } | null;
  } = { current: null };
  let stopped = false;
  for (let round = 1; round <= parsed.maxRounds && !stopped; round++) {
    const entry: RefinementRound = {
      round,
      candidates: [],
      winnerChildRunId: null,
      discardedChildRunIds: [],
    };
    const priorWinnerId: string | undefined = selection.current?.result.childRunId;
    const priorCandidate: { childRunId: string; summary: string } | undefined = selection.current
      ? {
          childRunId: selection.current.result.childRunId,
          summary: selection.current.result.summary,
        }
      : undefined;
    for (let index = 0; index < parsed.candidateCount; index++) {
      input.signal.throwIfAborted();
      await input.port.checkpoint();
      const available = {
        maxSteps: allowance.maxSteps - usage.modelTurns,
        tokenBudget: allowance.tokenBudget - usage.inputTokens - usage.outputTokens,
        costBudgetCents: allowance.costBudgetCents - (usage.costCents ?? allowance.costBudgetCents),
      };
      if (
        usage.costCents === null ||
        available.maxSteps < 2 ||
        available.tokenBudget < 512 ||
        available.costBudgetCents <= 0
      ) {
        state.stopReason = usage.costCents === null ? "cost_unknown" : "budget_exhausted";
        stopped = true;
        break;
      }
      const slots = parsed.candidateCount - index;
      const result = await input.port.runCandidate({
        round,
        index,
        signal: input.signal,
        objective: `${OBJECTIVES[index]}${renderRefinementLessons(state.lessonCodes)}`,
        ...(priorCandidate ? { priorCandidate } : {}),
        budget: {
          maxSteps: 2,
          tokenBudget: Math.max(512, Math.floor(available.tokenBudget / slots)),
          costBudgetCents: available.costBudgetCents / slots,
        },
      });
      input.signal.throwIfAborted();
      await input.port.checkpoint();
      results.push(result);
      usage.toolCalls += result.toolCalls;
      usage.modelTurns += result.usage.modelTurns;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.costCents =
        usage.costCents === null || result.usage.costCents === null
          ? null
          : usage.costCents + result.usage.costCents;
      const probe = probeRefinementCandidate(result);
      entry.candidates.push({
        childRunId: result.childRunId,
        specialistKey: result.specialistKey,
        probe,
      });
      if (
        probe.verdict === "pass" &&
        (!selection.current || probe.score > selection.current.probe.score)
      )
        selection.current = { result, probe };
    }
    entry.winnerChildRunId = selection.current?.result.childRunId ?? null;
    entry.discardedChildRunIds = entry.candidates
      .filter((candidate) => candidate.childRunId !== entry.winnerChildRunId)
      .map((candidate) => candidate.childRunId);
    // Distil only enumerated, code-owned process lessons from discarded branches.
    for (const candidate of entry.candidates)
      if (entry.discardedChildRunIds.includes(candidate.childRunId))
        state.lessonCodes = [
          ...new Set([...state.lessonCodes, ...lessonsFromProbe(candidate.probe)]),
        ];
    state.rounds.push(entry);
    state.winnerChildRunId = entry.winnerChildRunId;
    if (!stopped && round > 1 && selection.current?.result.childRunId === priorWinnerId) {
      state.stopReason = "converged";
      stopped = true;
    }
    await input.port.recordRound(structuredClone(state));
  }
  if (!selection.current && state.stopReason === "round_limit")
    state.stopReason = "no_valid_candidate";
  if (usage.costCents === null) state.stopReason = "cost_unknown";
  const conflicts = detectCollaborationConflicts(results);
  if (conflicts.length && !state.lessonCodes.includes("check_source_revision"))
    state.lessonCodes.push("check_source_revision");
  await input.port.recordRound(structuredClone(state));
  return {
    state,
    collaboration: {
      planKey: "harness_refinement_v1",
      status:
        selection.current &&
        conflicts.length === 0 &&
        !["cost_unknown", "budget_exhausted"].includes(state.stopReason)
          ? "complete"
          : "partial",
      results: selection.current ? [selection.current.result] : [],
      conflicts,
      usage,
    },
  };
}

export function usableRefinementExperiences(
  values: unknown[],
  versionId: string,
  now: number,
): RefinementExperience[] {
  return values
    .flatMap((value) => {
      const parsed = refinementExperienceSchema.safeParse(value);
      if (!parsed.success || parsed.data.versionId !== versionId) return [];
      const age = now - Date.parse(parsed.data.createdAt);
      return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000 ? [parsed.data] : [];
    })
    .slice(0, 8);
}
