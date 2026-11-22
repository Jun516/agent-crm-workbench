"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MotionDisclosure } from "@/components/ui/motion-disclosure";
import type { MemoryActivityView } from "@/lib/ai/customer-memory/view";
import { randomId } from "@/lib/random-id";
const labels: Record<MemoryActivityView["state"], string> = {
  queued: "等待后台整理",
  running: "正在整理",
  retry_wait: "整理失败，等待自动重试",
  failed: "整理失败，需要处理",
  unavailable: "未配置可用模型",
  skipped: "来源已变化，本次未整理",
  continuing: "本页已检查，后续页面继续整理",
  completed: "本次整理已完成",
  unverified: "整理结果尚未核验",
};
const sourceLabels: Record<string, string> = {
  conversation_close: "会话收口提炼",
  checkpoint: "长会话整理",
  workbench_complete: "报告完成后提炼",
  business_change: "经营事实冲突检查",
  maintenance_review: "夜间冲突检查",
  nightly: "夜间清洗与到期检查",
};
async function json(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "后台整理暂不可用");
  return value;
}
export function CustomerMemoryActivity({
  contactId,
  readOnly = false,
}: {
  contactId: string;
  readOnly?: boolean;
}) {
  return <Activity key={contactId} contactId={contactId} readOnly={readOnly} />;
}
function Activity({ contactId, readOnly }: { contactId: string; readOnly: boolean }) {
  const [rows, setRows] = useState<MemoryActivityView[]>([]),
    [canRetry, setCanRetry] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [cursor, setCursor] = useState<string | null>(null),
    [partial, setPartial] = useState(false),
    [busy, setBusy] = useState(false);
  const sequence = useRef(0),
    paged = useRef(false),
    keys = useRef(new Map<string, string>()),
    controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next?: string) => {
      const n = ++sequence.current;
      if (next) paged.current = true;
      try {
        const params = new URLSearchParams({ contact_id: contactId });
        if (next) params.set("cursor", next);
        const value = await json(
          await fetch(`/api/v1/ai/customer-memory/activity?${params}`, {
            signal: controller.current?.signal,
          }),
        );
        if (n !== sequence.current || controller.current?.signal.aborted) return;
        setRows((old) =>
          next
            ? [
                ...old,
                ...value.data.filter((r: MemoryActivityView) => !old.some((o) => o.id === r.id)),
              ]
            : value.data,
        );
        setCursor(value.meta?.cursor ?? null);
        setCanRetry(value.meta?.can_retry === true);
        setPartial(value.meta?.coverage === "partial");
        setError("");
        setLoading(false);
        paged.current = Boolean(next);
      } catch (e) {
        if (n === sequence.current && !controller.current?.signal.aborted) {
          setRows([]);
          setCanRetry(false);
          setCursor(null);
          setLoading(false);
          setError(e instanceof Error ? e.message : "后台整理暂不可用");
        }
      }
    },
    [contactId],
  );
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    void load();
    const timer = setInterval(() => {
      if (!paged.current && document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [load]);
  const retry = async (row: MemoryActivityView) => {
    const key = keys.current.get(row.id) ?? randomId();
    keys.current.set(row.id, key);
    setBusy(true);
    setError("");
    try {
      await json(
        await fetch("/api/v1/ai/customer-memory/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: contactId,
            job_id: row.id,
            revision: row.revision,
            request_key: key,
          }),
        }),
      );
      keys.current.delete(row.id);
      paged.current = false;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重试结果尚未确认，请刷新");
    } finally {
      setBusy(false);
    }
  };
  const needsAttention = rows.some((r) =>
    ["unavailable", "failed", "retry_wait", "unverified"].includes(r.state),
  );
  return (
    <section aria-label="后台记忆整理" className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">后台记忆整理</h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            paged.current = false;
            void load();
          }}
        >
          刷新整理状态
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-sm">
          正在读取整理状态…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && !rows.length && (
        <p className="text-xs text-muted-foreground">
          {partial
            ? "本批没有可展示记录，仍有后台记录待扫描，请继续加载。"
            : "暂无可展示的后台整理记录；这不表示客户没有相关偏好。"}
        </p>
      )}
      {needsAttention && (
        <p className="text-sm">
          自动整理需要处理；已确认记忆仍可使用。未配置模型时，请管理员在{" "}
          <Link className="underline" href="/app/ai/providers">
            模型设置
          </Link>{" "}
          完成配置，再由负责人或经理重试。
        </p>
      )}
      {rows.length > 0 && (
        <MotionDisclosure title={needsAttention ? "查看需要处理的整理记录" : "查看整理记录"}>
          <div className="space-y-3">
            {rows.map((row) => (
              <article key={row.id} className="space-y-1 border-t py-2 text-sm">
                <p>
                  {sourceLabels[row.source_kind] ?? "记忆整理"} · {labels[row.state]}
                </p>
                <p className="text-xs text-muted-foreground">
                  创建于 {new Date(row.created_at).toLocaleString()}
                  {["queued", "retry_wait"].includes(row.state)
                    ? ` · 计划执行 ${new Date(row.run_after).toLocaleString()}`
                    : ""}
                </p>
                {row.state === "completed" && (
                  <p className="text-xs">
                    整理完成仅表示本次任务结束，建议仍须人工确认；请以下方候选和冲突队列为准。
                  </p>
                )}
                {row.state === "unavailable" && (
                  <p>缺少可用模型，尚未完成提炼或检查，不是“没有建议”。</p>
                )}
                {row.retryable && canRetry && !readOnly && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void retry(row)}
                  >
                    重试整理
                  </Button>
                )}
              </article>
            ))}
          </div>
        </MotionDisclosure>
      )}
      {cursor && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(cursor)}>
          继续加载整理记录
        </Button>
      )}
    </section>
  );
}
