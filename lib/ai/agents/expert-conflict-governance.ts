import type { AgentCollaborationConflict } from "@/lib/ai/agents/collaboration";

/**
 * Parent policy hook for material expert disagreement.
 *
 * A field-hash mismatch cannot be settled by picking a hash: the parent must
 * ask, writes stop, and the conflict stays unresolved. A source-revision
 * mismatch cannot be settled by writing either side: writes stop and the run
 * stays unresolved until a fresh read. Specialist failure is not this hook.
 * `mark_unresolved` is the run state applied with every decision — a report
 * line is not a decision.
 */
export const PARENT_CONFLICT_ACTIONS = ["ask", "stop_writes", "mark_unresolved"] as const;
export type ParentConflictAction = (typeof PARENT_CONFLICT_ACTIONS)[number];

export const EXPERT_CONFLICT_UNRESOLVED = "expert_conflict_unresolved";

export interface ParentConflictGovernance {
  hook: "parent_governance";
  /** Operator-facing disposition. Writes are stopped and the run is unresolved. */
  action: ParentConflictAction;
  actions: ParentConflictAction[];
  writes: "stopped";
  unresolved: true;
  /** Present when the disposition is `ask`. Names fields, never field values. */
  question: string | null;
  fields: string[];
  codes: Array<"evidence_disagreement" | "stale_state">;
}

export function governParentOnExpertConflict(
  conflicts: readonly AgentCollaborationConflict[],
): ParentConflictGovernance | null {
  const material = conflicts.filter(
    (
      conflict,
    ): conflict is AgentCollaborationConflict & {
      code: "evidence_disagreement" | "stale_state";
    } => conflict.code === "evidence_disagreement" || conflict.code === "stale_state",
  );
  if (material.length === 0) return null;
  const fields = [
    ...new Set(
      material.map((conflict) => conflict.field).filter((field): field is string => Boolean(field)),
    ),
  ];
  const codes = [...new Set(material.map((conflict) => conflict.code))];
  const disagreement = codes.includes("evidence_disagreement");
  const action: ParentConflictAction = disagreement ? "ask" : "stop_writes";
  const actions: ParentConflictAction[] = disagreement
    ? ["ask", "stop_writes", "mark_unresolved"]
    : ["stop_writes", "mark_unresolved"];
  const decision: ParentConflictGovernance = {
    hook: "parent_governance",
    action,
    actions,
    writes: "stopped",
    unresolved: true,
    question: null,
    fields,
    codes,
  };
  decision.question = action === "ask" ? unresolvedExpertConflictText(decision) : null;
  return decision;
}

export function parentMayWriteAfterExperts(governance: ParentConflictGovernance | null): boolean {
  return governance === null;
}

export function unresolvedExpertConflictText(governance: ParentConflictGovernance): string {
  const fields = governance.fields.length ? `涉及：${governance.fields.join("、")}。` : "";
  if (governance.action === "ask") {
    return `专家对同一 CRM 字段的观察不一致。${fields}父 Agent 不能代选一边。请负责人确认应以哪一次读取为准。在回答前，CRM 写入已停止，冲突保持未解决。`;
  }
  return `专家读取了不同的来源版本。${fields}父 Agent 已停止 CRM 写入，并将冲突标为未解决。请重新读取当前版本后再决定是否写入。`;
}

export function expertConflictEventFields(
  governance: ParentConflictGovernance | null,
): Record<string, unknown> {
  if (!governance) return {};
  return {
    governance: governance.action,
    writes: governance.writes,
    unresolved: governance.unresolved,
  };
}

export function parentTurnAfterExperts(
  outcome: { governance: ParentConflictGovernance | null } | null,
):
  | { kind: "synthesize" }
  | {
      kind: "govern";
      governance: ParentConflictGovernance;
      finalText: string;
      errorCode: typeof EXPERT_CONFLICT_UNRESOLVED;
    } {
  if (!outcome?.governance) return { kind: "synthesize" };
  return {
    kind: "govern",
    governance: outcome.governance,
    finalText: unresolvedExpertConflictText(outcome.governance),
    errorCode: EXPERT_CONFLICT_UNRESOLVED,
  };
}

type NoticeEvent = { event_type: string; payload?: Record<string, unknown> | null };

function governanceAction(value: unknown): ParentConflictAction | null {
  return value === "ask" || value === "stop_writes" || value === "mark_unresolved" ? value : null;
}

/** Workbench copy for an existing run timeline. Null when the parent did not govern. */
export function expertConflictNotice(
  events: readonly NoticeEvent[],
): { title: string; body: string } | null {
  const governed = events.filter((event) => {
    const action = governanceAction(event.payload?.governance);
    return (
      (event.event_type === "collaboration_conflict" ||
        event.event_type === "collaboration_completed") &&
      (action !== null || event.payload?.unresolved === true)
    );
  });
  if (governed.length === 0) return null;
  const action =
    governed
      .map((event) => governanceAction(event.payload?.governance))
      .find((item) => item === "ask") ??
    governed.map((event) => governanceAction(event.payload?.governance)).find((item) => item) ??
    "mark_unresolved";
  const fields = [
    ...new Set(
      governed
        .map((event) => event.payload?.field)
        .filter((field): field is string => typeof field === "string" && field.length > 0),
    ),
  ];
  return {
    title: "专家冲突未解决",
    body: unresolvedExpertConflictText({
      hook: "parent_governance",
      action,
      actions:
        action === "ask"
          ? ["ask", "stop_writes", "mark_unresolved"]
          : ["stop_writes", "mark_unresolved"],
      writes: "stopped",
      unresolved: true,
      question: null,
      fields,
      codes: [],
    }),
  };
}

/** Extra timeline sentence. The base event label stays so existing readers still match it. */
export function expertConflictTimelineNote(event: NoticeEvent): string | null {
  if (event.event_type === "run_partial" && event.payload?.reason === EXPERT_CONFLICT_UNRESOLVED)
    return "父 Agent 已停止写入，冲突保持未解决。";
  const governedEvent =
    event.event_type === "collaboration_conflict" || event.event_type === "collaboration_completed";
  if (!governedEvent) return null;
  const action = governanceAction(event.payload?.governance);
  if (action === "ask") return "父 Agent 未代选一边：已停止写入，并要求负责人确认。";
  if (
    action === "stop_writes" ||
    action === "mark_unresolved" ||
    event.payload?.unresolved === true
  )
    return "父 Agent 已停止写入，冲突保持未解决。";
  return null;
}
