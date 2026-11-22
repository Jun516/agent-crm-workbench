import type pg from "pg";

import type { AgentRuntime } from "@/lib/agent-runtime";
import { createCustomerMemoryCall } from "@/lib/ai/customer-memory/consumption";
import type { CustomerMemoryScope } from "@/lib/ai/customer-memory/context";
import {
  loadMissionBudgetForRun,
  missionBudgetBlockReason,
  MissionBudgetExceededError,
} from "@/lib/ai/agents/mission-budget";

import type { Logger } from "../obs/logger";
import {
  runModelCall,
  type LlmEdgeConfig,
  type RunModelCallInput,
} from "../edge/llm/run-model-call";

/**
 * Adapter seam for a CRM turn's model execution.
 *
 * The CRM turn still owns the business policy around a call (context, tool
 * outcomes, checkpoint validation, handoff, and persistence). The generic
 * model-call plumbing lives here so that the turn does not become a second
 * runtime: provider resolution, budget, usage/audit, and the Pi loop remain
 * behind the model gateway and injected AgentRuntime contract.
 */
export async function executePiTurnModelCall(
  deps: {
    pool: pg.Pool;
    llmCfg: LlmEdgeConfig;
    log: Logger;
    runtime?: AgentRuntime;
    customerMemory?: CustomerMemoryScope;
  },
  input: RunModelCallInput,
) {
  const missionBudget = input.workbenchRunId
    ? await loadMissionBudgetForRun(deps.pool, input.tenantId, input.workbenchRunId)
    : null;
  if (missionBudget) {
    const reason = missionBudgetBlockReason(missionBudget);
    if (reason) throw new MissionBudgetExceededError(reason);
  }
  const remainingTokens = missionBudget
    ? missionBudget.maxTotalTokens - missionBudget.usedTokens
    : null;
  const remainingCostCents = missionBudget
    ? missionBudget.maxTotalCostCents - missionBudget.usedCostCents
    : null;
  const guardedInput = missionBudget
    ? {
        ...input,
        shouldStopAfterTurn: async (
          turn: Parameters<NonNullable<typeof input.shouldStopAfterTurn>>[0],
        ) =>
          Boolean(await input.shouldStopAfterTurn?.(turn)) ||
          turn.cumulativeUsage.totalTokens >= remainingTokens! ||
          turn.costCents === null ||
          turn.costCents >= remainingCostCents!,
      }
    : input;
  const memory = deps.customerMemory
    ? createCustomerMemoryCall(deps.pool, guardedInput, deps.customerMemory)
    : null;
  try {
    const result = await runModelCall(deps.pool, deps.llmCfg, memory?.input ?? guardedInput, {
      log: deps.log,
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
    });
    await memory?.finish(result.callId, "success");
    return result;
  } catch (error) {
    await memory?.finish(null, "error").catch(() => {
      deps.log.error("customer_memory_receipt_failed", {
        organization_id: input.tenantId,
        code: "consumption_receipt_unavailable",
      });
    });
    throw error;
  }
}
