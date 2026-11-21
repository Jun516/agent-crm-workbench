import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentRuntimeEvent, RuntimeMessage } from "@/lib/agent-runtime";
import {
  directionReachedModel,
  loadMissionDirectionContextProbe,
  persistMissionRunMessagesAndDirectionAck,
} from "./mission-direction-consumption";

const direction = '先核对"新版"报价，再联系客户';
const probeId = "manager-direction:mission-1:2";
const successful: AgentRuntimeEvent[] = [{ type: "model_context_consumed", data: { probeId } }];
const transcript: RuntimeMessage[] = [
  { role: "user", content: `负责人方向：${JSON.stringify(direction)}` },
  { role: "assistant", content: "已核对当前资料" },
];

describe("Mission direction consumption evidence", () => {
  it("requires the serialized direction in the actual model prompt and a successful turn", () => {
    expect(directionReachedModel(transcript, successful, direction, probeId)).toBe(true);
    expect(
      directionReachedModel([{ role: "user", content: "旧方向" }], successful, direction, probeId),
    ).toBe(false);
    expect(
      directionReachedModel(
        transcript,
        [{ type: "steering_queued", data: { steeringId: "direction-1" } }],
        direction,
        probeId,
      ),
    ).toBe(false);
    expect(
      directionReachedModel(
        transcript,
        [{ type: "turn_end", data: { stop_reason: "stop" } }],
        direction,
        probeId,
      ),
    ).toBe(false);
    expect(
      directionReachedModel(
        transcript,
        [{ type: "model_context_consumed", data: { probeId: "other" } }],
        direction,
        probeId,
      ),
    ).toBe(false);
  });
});

function queryPool(row: Record<string, unknown> | null) {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  return { pool: { query } as unknown as Pool, query };
}

describe("Mission direction context probe", () => {
  const current = {
    current_direction: direction,
    direction_revision: "2",
    run_revision: "2",
    run_status: "running",
  };

  it("loads only the revision pinned on the running root", async () => {
    const { pool } = queryPool(current);
    await expect(
      loadMissionDirectionContextProbe(pool, {
        organizationId: "org-a",
        missionId: "mission-1",
        runId: "run-a",
        expectedRevision: 2,
      }),
    ).resolves.toEqual({
      id: probeId,
      userText: JSON.stringify(direction),
    });
  });

  it("rejects a stale revision before any direction text can enter the model context", async () => {
    const stale = queryPool({ ...current, direction_revision: "3", run_revision: "2" });
    await expect(
      loadMissionDirectionContextProbe(stale.pool, {
        organizationId: "org-a",
        missionId: "mission-1",
        runId: "run-a",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(stale.query).toHaveBeenCalledOnce();

    const missing = queryPool(current);
    await expect(
      loadMissionDirectionContextProbe(missing.pool, {
        organizationId: "org-a",
        missionId: "mission-1",
        runId: "run-a",
        expectedRevision: undefined,
      }),
    ).rejects.toMatchObject({ code: "revision_missing" });
    expect(missing.query).not.toHaveBeenCalled();
  });
});

describe("Mission direction acknowledgement", () => {
  it("does not persist messages when the saved transcript is not the current direction", async () => {
    const calls: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("from public.ai_missions")) {
          return {
            rows: [
              {
                current_direction: direction,
                direction_revision: "2",
                direction_consumed_revision: "0",
              },
            ],
          };
        }
        if (sql.includes("from public.ai_workbench_runs")) {
          return { rows: [{ status: "running", run_revision: "2" }] };
        }
        return { rows: [] };
      }),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    await expect(
      persistMissionRunMessagesAndDirectionAck(pool, {
        organizationId: "org-a",
        missionId: "mission-1",
        runId: "run-a",
        expectedRevision: 1,
        messages: [{ role: "user", content: "旧任务" }],
        events: successful,
      }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(calls.some((sql) => sql.includes("ai_agent_run_states"))).toBe(false);
    expect(calls.at(-1)).toBe("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a current revision that never reached the model prompt", async () => {
    const calls: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("from public.ai_missions")) {
          return {
            rows: [
              {
                current_direction: direction,
                direction_revision: "2",
                direction_consumed_revision: "1",
              },
            ],
          };
        }
        if (sql.includes("from public.ai_workbench_runs")) {
          return { rows: [{ status: "running", run_revision: "2" }] };
        }
        return { rows: [] };
      }),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    await expect(
      persistMissionRunMessagesAndDirectionAck(pool, {
        organizationId: "org-a",
        missionId: "mission-1",
        runId: "run-a",
        expectedRevision: 2,
        messages: [{ role: "user", content: "旧任务，不含负责人新方向" }],
        events: successful,
      }),
    ).rejects.toMatchObject({ code: "context_missing" });
    expect(calls.some((sql) => sql.includes("set direction_consumed_revision"))).toBe(false);
    expect(calls.some((sql) => sql.includes("ai_agent_run_states"))).toBe(false);
    expect(calls.at(-1)).toBe("rollback");
  });
});
