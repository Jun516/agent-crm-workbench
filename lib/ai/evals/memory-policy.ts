import type { AgentEvalFinding, MemoryEvaluationRecall } from "./contracts";
/** Deterministic, body-free policy checks. A good score never validates natural language. */
export function evaluateMemoryRecallPolicy(recalls: MemoryEvaluationRecall[]): AgentEvalFinding[] {
  const findings: AgentEvalFinding[] = [];
  for (const r of recalls) {
    const ids = new Set(r.memory_ids);
    const missing = r.required_memory_ids.filter((id) => !ids.has(id)).length;
    if (!r.scope_valid)
      findings.push({
        code: "memory_policy_scope_mismatch",
        message: "记忆读取回执与运行的客户作用域不一致。",
      });
    if (missing)
      findings.push({
        code: "memory_policy_locked_missing",
        message: "独立 SQL 记录表明读取时有效的锁定约束没有进入上下文。",
        evidence: { missing },
      });
    if (r.invalid_memory_ids.length)
      findings.push({
        code: "memory_policy_invalid_injected",
        message: "读取回执包含已过期、已停用或版本不匹配的记忆。",
        evidence: { invalid: r.invalid_memory_ids.length },
      });
    if (r.metadata_error_count)
      findings.push({
        code: "memory_policy_metadata_mismatch",
        message: "记忆读取时的风险、锁定或待复核标注与可核验 SQL 版本不一致。",
        evidence: { mismatched: r.metadata_error_count },
      });
    if (ids.size !== r.returned_count)
      findings.push({
        code: "memory_policy_receipt_mismatch",
        message: "召回数量与实际读取明细不一致。",
      });
    if (r.uncertain_policy_count)
      findings.push({
        code: "memory_policy_history_unverifiable",
        message: "部分记忆在读取后经过人工变更，当前版本不能完整证明历史策略是否正确。",
        evidence: { changed: r.uncertain_policy_count },
      });
    if (r.coverage !== "complete")
      findings.push({
        code: "confirmed_memory_coverage_incomplete",
        message: "召回范围不完整，未召回不得解释为客户没有该偏好。",
      });
  }
  if (recalls.some((r) => r.memory_ids.length))
    findings.push({
      code: "memory_claims_require_semantic_review",
      message: "已核对记忆读取回执及可证明的策略约束；自然语言采用情况和 L0 优先仍需语义复核。",
    });
  return findings;
}
export const memoryPolicyFailure = (code: string) =>
  code.startsWith("memory_policy_") && code !== "memory_policy_history_unverifiable";
