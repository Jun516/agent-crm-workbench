"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MEMORY_TYPE_LABELS } from "@/lib/ai/customer-memory/view";

type Usage = {
  id: string;
  memory_id: string;
  policy_revision: number;
  memory_type: string;
  risk_level: string;
  locked: boolean;
  needs_review: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  used_at: string;
  body: string | null;
  retired: boolean;
  current_version_changed: boolean;
  corrected_at: string | null;
  correction_reason: string | null;
  evidence_conversation_id: string | null;
};
type Recall = {
  id: string;
  status: string;
  coverage: string;
  provider_status: string;
  returned_count: number;
  call_outcome: string;
};
async function readJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "无法读取记忆使用记录，请重试。");
  return value;
}
export function CustomerMemoryUsage({
  context,
  id,
  readOnly = false,
}: {
  context: "workbench" | "draft" | "conversation";
  id: string;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<Usage[]>([]);
  const [recalls, setRecalls] = useState<Recall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [recallsMore, setRecallsMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    async (next?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams({ context, id });
      if (next) query.set("cursor", next);
      const value = await readJson(
        await fetch(`/api/v1/ai/customer-memory/usage?${query}`, { signal }),
      );
      if (signal?.aborted) return;
      setRows((old) =>
        next
          ? [...old, ...value.data.usage.filter((r: Usage) => !old.some((o) => o.id === r.id))]
          : value.data.usage,
      );
      setRecalls(value.data.recalls);
      setCursor(value.meta?.cursor ?? null);
      setRecallsMore(Boolean(value.meta?.recalls_has_more));
      setError("");
    },
    [context, id],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRows([]);
    setRecalls([]);
    setCursor(null);
    setError("");
    void load(undefined, controller.signal)
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "记忆记录暂不可用。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, refresh]);
  return (
    <section aria-label="本次使用的客户记忆" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">本次使用的客户记忆</h3>
        <Button variant="ghost" size="sm" onClick={() => setRefresh((v) => v + 1)}>
          刷新使用记录
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        这里记录模型请求实际读取的已确认记忆，不能据此认定回答采纳了每一条。未召回不代表客户没有相关偏好。
      </p>
      {loading && (
        <p role="status" className="text-sm">
          正在核对使用记录…
        </p>
      )}
      {!loading && !error && !recalls.length && (
        <p className="text-sm text-muted-foreground">
          尚无可核验的读取回执。请核对生成状态；历史报告可能没有记录。
        </p>
      )}
      {recalls.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>召回状态与覆盖范围（最近 {recalls.length} 次请求）</summary>
          <ul className="mt-2 space-y-1">
            {recalls.map((r) => (
              <li key={r.id}>
                {r.status} · 覆盖 {r.coverage} · 检索服务 {r.provider_status} · {r.returned_count}{" "}
                条{r.call_outcome === "error" ? " · 本次调用随后失败，已完成步骤仍保留回执" : ""}
              </li>
            ))}
          </ul>
          {recallsMore && <p>这里只展示最近 20 次召回诊断，下方记忆记录可继续加载。</p>}
        </details>
      )}
      {!loading && !error && recalls.length > 0 && !rows.length && (
        <p className="text-sm">
          模型读取了当前 SQL 召回结果，其中未包含确认记忆。这不表示客户没有偏好。
        </p>
      )}
      {rows.map((row) => (
        <UsageCard
          key={`${row.id}:${row.corrected_at}`}
          row={row}
          context={context}
          artifactId={id}
          readOnly={readOnly}
          onChanged={() => setRefresh((v) => v + 1)}
        />
      ))}
      {cursor && (
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await load(cursor);
            } catch (e) {
              setError(e instanceof Error ? e.message : "加载失败。");
            } finally {
              setLoading(false);
            }
          }}
        >
          加载更多使用记录
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
function UsageCard({
  row,
  context,
  artifactId,
  readOnly,
  onChanged,
}: {
  row: Usage;
  context: "workbench" | "draft" | "conversation";
  artifactId: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <article className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="break-words whitespace-pre-wrap">
        {row.body ??
          (row.retired ? "该记忆已停用，正文不再展示。" : "当前正文已变更，历史正文不再展示。")}
      </p>
      <p className="text-xs text-muted-foreground">
        {MEMORY_TYPE_LABELS[row.memory_type] ?? row.memory_type} · 风险 {row.risk_level} ·{" "}
        {row.locked ? "读取时已锁定" : "读取时未锁定"} ·{" "}
        {row.needs_review ? "读取时待复核" : "读取时已确认"}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary>记忆 ID、版本与确认信息</summary>
        <p className="break-all">
          {row.memory_id} · 版本 {row.policy_revision}
        </p>
        <p className="break-all">
          确认人：{row.confirmed_by ?? "历史记录未提供"} ·{" "}
          {row.confirmed_at ? new Date(row.confirmed_at).toLocaleString() : "时间未记录"}
        </p>
        <p>读取时间：{new Date(row.used_at).toLocaleString()}</p>
      </details>
      {row.current_version_changed && (
        <p className="text-xs">记忆已有后续变更，请以当前客户记忆面板为准。</p>
      )}
      {row.evidence_conversation_id && (
        <Link
          className="text-xs underline"
          href={`/app/inbox?id=${encodeURIComponent(row.evidence_conversation_id)}`}
        >
          查看证据会话
        </Link>
      )}
      {row.corrected_at ? (
        <p role="status" className="text-xs">
          已提交纠正：{row.correction_reason}。匹配的当前版本会进入待复核，人工后续版本保持原样。
        </p>
      ) : (
        !readOnly && (
          <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
            纠正这次记忆使用
          </Button>
        )
      )}
      {editing && !row.corrected_at && !readOnly && (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await readJson(
                await fetch("/api/v1/ai/customer-memory/usage", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    usage_id: row.id,
                    reason: reason.trim(),
                    context,
                    id: artifactId,
                  }),
                }),
              );
              onChanged();
            } catch (e) {
              setError(e instanceof Error ? e.message : "纠正暂不可用。");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Textarea
            aria-label="记忆使用纠正原因"
            placeholder="说明哪条偏好已过时，或为何不适合这次回答。不会直接改写客户事实。"
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
            提交纠正并待复核
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
