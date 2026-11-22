import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPPORTUNITY_REVIEW_PLAN, type AgentSpecialistResult } from "@/lib/ai/agents/collaboration";
import {
  detectCollaborationConflicts,
  formatCollaborationContext,
} from "@/lib/ai/agents/collaboration-runtime";
import {
  EXPERT_CONFLICT_UNRESOLVED,
  expertConflictNotice,
  expertConflictTimelineNote,
  governParentOnExpertConflict,
  parentMayWriteAfterExperts,
  parentTurnAfterExperts,
} from "@/lib/ai/agents/expert-conflict-governance";

function result(
  specialistKey: string,
  claims: AgentSpecialistResult["claims"] = [],
): AgentSpecialistResult {
  return {
    childRunId: `child-${specialistKey}`,
    specialistKey,
    status: "complete",
    summary: "summary",
    evidence: [],
    claims,
    missingMaterial: [],
    toolCalls: 1,
    usage: { inputTokens: 1, outputTokens: 1, costCents: 0, modelTurns: 1 },
  };
}

function claim(specialistKey: string, valueHash: string, revision: string) {
  return {
    id: `${specialistKey}-claim`,
    specialistKey,
    subject: { resource: "lead", id: "lead-1" },
    field: "stage_id",
    valueHash,
    valueType: "string" as const,
    locator: { provider: "crm_tool", sourceId: "lead:lead-1", revision },
  };
}

describe("parent governance on expert conflict", () => {
  it("does not govern a specialist failure or an agreement", () => {
    expect(
      governParentOnExpertConflict([
        { code: "specialist_failure", specialistKeys: ["customer_evidence"], message: "failed" },
      ]),
    ).toBeNull();
    const agreed = [
      result("customer_evidence", [claim("customer_evidence", "hash-a", "1")]),
      result("opportunity_diagnosis", [claim("opportunity_diagnosis", "hash-a", "1")]),
    ];
    expect(governParentOnExpertConflict(detectCollaborationConflicts(agreed))).toBeNull();
    expect(parentMayWriteAfterExperts(null)).toBe(true);
    expect(parentTurnAfterExperts(null)).toEqual({ kind: "synthesize" });
    expect(parentTurnAfterExperts({ governance: null })).toEqual({ kind: "synthesize" });
  });

  it("forces a follow-up question, stops writes, and marks a field-hash conflict unresolved", () => {
    const conflicts = detectCollaborationConflicts([
      result("customer_evidence", [claim("customer_evidence", "hash-a", "1")]),
      result("opportunity_diagnosis", [claim("opportunity_diagnosis", "hash-b", "1")]),
    ]);
    const governance = governParentOnExpertConflict(conflicts);
    expect(governance).toMatchObject({
      hook: "parent_governance",
      action: "ask",
      actions: ["ask", "stop_writes", "mark_unresolved"],
      writes: "stopped",
      unresolved: true,
      fields: ["lead:lead-1:stage_id"],
    });
    expect(governance?.question).toContain("不能代选一边");
    expect(governance?.question).toContain("lead:lead-1:stage_id");
    expect(governance?.question).not.toMatch(/hash-a|hash-b/);
    expect(parentMayWriteAfterExperts(governance)).toBe(false);
    const turn = parentTurnAfterExperts({ governance });
    expect(turn).toMatchObject({
      kind: "govern",
      errorCode: EXPERT_CONFLICT_UNRESOLVED,
    });
    if (turn.kind !== "govern") throw new Error("expected governance");
    expect(turn.finalText).toBe(governance?.question);
    expect(
      formatCollaborationContext({
        planKey: OPPORTUNITY_REVIEW_PLAN.key,
        status: "complete",
        results: [],
        conflicts,
        governance,
        usage: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costCents: 0, modelTurns: 0 },
      }),
    ).not.toContain("请综合它们");
  });

  it("stops writes on a source-version mismatch without asking the parent to pick a side", () => {
    const conflicts = detectCollaborationConflicts([
      result("customer_evidence", [claim("customer_evidence", "hash-a", "1")]),
      result("opportunity_diagnosis", [claim("opportunity_diagnosis", "hash-a", "2")]),
    ]);
    expect(conflicts.map((conflict) => conflict.code)).toEqual(["stale_state"]);
    const governance = governParentOnExpertConflict(conflicts);
    expect(governance).toMatchObject({
      action: "stop_writes",
      actions: ["stop_writes", "mark_unresolved"],
      writes: "stopped",
      unresolved: true,
      question: null,
    });
    expect(parentMayWriteAfterExperts(governance)).toBe(false);
    const turn = parentTurnAfterExperts({ governance });
    if (turn.kind !== "govern") throw new Error("expected governance");
    expect(turn.finalText).toContain("已停止 CRM 写入");
    expect(turn.finalText).not.toMatch(/hash-a/);
  });

  it("shows the unresolved decision on the existing workbench timeline", () => {
    const events = [
      {
        event_type: "collaboration_conflict",
        payload: {
          code: "evidence_disagreement",
          field: "lead:lead-1:stage_id",
          governance: "ask",
          writes: "stopped",
          unresolved: true,
        },
      },
      {
        event_type: "collaboration_completed",
        payload: { governance: "ask", writes: "stopped", unresolved: true },
      },
      { event_type: "run_partial", payload: { reason: EXPERT_CONFLICT_UNRESOLVED } },
      { event_type: "collaboration_conflict", payload: { code: "specialist_failure" } },
    ];
    expect(expertConflictNotice(events)).toEqual({
      title: "专家冲突未解决",
      body: expect.stringContaining("lead:lead-1:stage_id"),
    });
    expect(expertConflictNotice(events)?.body).toContain("不能代选一边");
    expect(expertConflictTimelineNote(events[0]!)).toContain("要求负责人确认");
    expect(expertConflictTimelineNote(events[2]!)).toContain("已停止写入");
    expect(expertConflictTimelineNote(events[3]!)).toBeNull();
    expect(expertConflictNotice([])).toBeNull();
  });

  it("keeps experts read-only and closes the parent before write tools exist", () => {
    expect(OPPORTUNITY_REVIEW_PLAN.specialists.every((item) => item.effect === "read")).toBe(true);
    expect(OPPORTUNITY_REVIEW_PLAN.writer).toBe("parent_only");
    const specialist = readFileSync("lib/ai/agents/workbench-collaboration.ts", "utf8");
    expect(specialist).toContain('effect?.effect !== "read"');
    expect(specialist).toContain("specialist_read_only_boundary");
    const start = readFileSync("lib/ai/agents/workbench-start-job.ts", "utf8");
    const governAt = start.indexOf("const governedTurn = parentTurnAfterExperts");
    const toolsAt = start.indexOf("workbenchMcp = await buildMcpTurnTools");
    expect(governAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeGreaterThan(governAt);
    expect(start).toContain("governedTurn.errorCode");
    expect(start.slice(governAt, toolsAt)).toContain("return");
  });
});
