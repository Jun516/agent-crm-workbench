"use client";

import { useRef, useState } from "react";
import { directionConsumptionLine } from "@/lib/ai/agents/mission-direction-status";
import { randomId } from "@/lib/random-id";

const EDITABLE = new Set([
  "queued",
  "running",
  "needs_review",
  "waiting_customer",
  "waiting_approval",
]);

export type AcceptedMissionDirection = {
  runId: string;
  replayed: boolean;
  customerSendPaused: boolean;
  directionRevision?: number;
  direction: string;
};

export function MissionDirectionControl({
  mission,
  onAccepted,
  readOnly = false,
}: {
  mission: {
    id: string;
    status: string;
    current_direction?: string | null;
    direction_revision?: unknown;
    direction_consumed_revision?: unknown;
  };
  onAccepted: (accepted: AcceptedMissionDirection) => Promise<void>;
  readOnly?: boolean;
}) {
  const [direction, setDirection] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = useRef<{ direction: string; requestKey: string } | null>(null);
  const editable = !readOnly && EDITABLE.has(mission.status);
  const consumption = directionConsumptionLine({
    currentDirection: mission.current_direction,
    directionRevision: mission.direction_revision,
    directionConsumedRevision: mission.direction_consumed_revision,
  });
  const submit = async () => {
    const text = direction.trim();
    if (inFlight.current || !editable || text.length < 5) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    if (!pending.current || pending.current.direction !== text)
      pending.current = { direction: text, requestKey: randomId() };
    const request = pending.current;
    try {
      const response = await fetch(`/api/v1/ai/missions/${mission.id}/follow-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.requestKey,
        },
        body: JSON.stringify({ direction: request.direction }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法补充任务方向，请重试。");
      if (
        typeof body.data?.runId !== "string" ||
        typeof body.data?.customerSendPaused !== "boolean"
      )
        throw new Error("无法确认新的任务方向，请刷新后核对。");
      await onAccepted({
        runId: body.data.runId,
        replayed: body.data.replayed === true,
        customerSendPaused: body.data.customerSendPaused,
        ...(typeof body.data.directionRevision === "number"
          ? { directionRevision: body.data.directionRevision }
          : {}),
        direction: request.direction,
      });
      pending.current = null;
      setDirection("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法确认新的任务方向，请重试。");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      {mission.current_direction && (
        <p className="text-xs text-muted-foreground">负责人方向：{mission.current_direction}</p>
      )}
      {consumption && <p className="text-xs text-muted-foreground">{consumption}</p>}
      {editable && (
        <>
          <label className="block text-xs">
            负责人补充任务方向
            <textarea
              id={`manager-direction-${mission.id}`}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              disabled={sending}
              maxLength={2000}
              rows={3}
              className="mt-1 w-full rounded-md border bg-background p-2"
              placeholder="例如改用最新报价依据，先核对已执行动作，再提出新方案"
            />
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || direction.trim().length < 5}
            className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {sending ? "正在保存方向…" : "保存方向并继续任务"}
          </button>
          <p className="text-xs text-muted-foreground">
            提交会停止旧运行，旧提案会撤销，客户发送会暂停；已完成的动作不会回滚，新运行会重新核对。此文字不批准报价或外发，恢复发送须另行操作。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
