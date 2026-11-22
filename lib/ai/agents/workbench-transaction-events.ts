import type { Pool, PoolClient } from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { assertWorkbenchJobLease } from "@/lib/ai/agents/workbench-job-lease";
import {
  type CrmAgentEventType, projectTerminalWorkbenchRun, redactEventPayload,
} from "@/lib/ai/agents/workbench-events";

/** Append a product event inside the transaction that owns its state change. */
export async function appendWorkbenchEventTx(
  client: PoolClient, organizationId: string, runId: string,
  type: CrmAgentEventType, payload: Record<string, unknown>,
): Promise<void> {
  const safePayload = redactEventPayload(type, payload);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { rows } = await client.query(
      `insert into public.ai_agent_run_events
       (organization_id,run_id,sequence,event_type,payload)
       select $1,$2,coalesce(max(sequence),0)+1,$3,$4::jsonb
       from public.ai_agent_run_events
       where organization_id=$1 and run_id=$2
       on conflict (run_id,sequence) do nothing returning sequence`,
      [organizationId, runId, type, JSON.stringify(safePayload)],
    );
    if (rows.length === 1) return;
  }
  throw new Error("workbench_event_sequence_race");
}

/** A governed stop and its evidence must commit together. */
export async function commitWorkbenchGovernanceStop(
  pool: Pool,
  input: {
    job: JobRow;
    workerId: string;
    runId: string;
    finalText: string;
    errorCode: string;
    usage: { inputTokens: number; outputTokens: number; costCents: number | null; calls: number };
  },
): Promise<void> {
  const organizationId = input.job.organization_id;
  const client = await pool.connect();
  let closed = false;
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    await assertWorkbenchJobLease(client, input.job, input.workerId);
    const { rowCount } = await client.query(
      `update public.ai_workbench_runs
       set status='partial', final_text=$3, error_code=$4, completed_at=now()
       where organization_id=$1 and id=$2 and run_kind='root' and status='running'`,
      [organizationId, input.runId, input.finalText, input.errorCode],
    );
    if (rowCount === 1) {
      closed = true;
      await appendWorkbenchEventTx(client, organizationId, input.runId, "run_partial", {
        status: "partial",
        pendingProposals: 0,
        reason: input.errorCode,
      });
      await appendWorkbenchEventTx(client, organizationId, input.runId, "usage_reported", input.usage);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  if (closed) await projectTerminalWorkbenchRun(organizationId, input.runId);
}
