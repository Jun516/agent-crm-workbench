"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CustomerMemoryMetrics as Metrics } from "@/lib/ai/customer-memory/metrics";
const percent = (n: number | null) => (n === null ? "暂无样本" : `${(n * 100).toFixed(1)}%`);
const elapsed = (n: number | null) =>
  n === null
    ? "暂无样本"
    : n < 3600
      ? `${Math.round(n / 60)} 分钟`
      : `${(n / 3600).toFixed(1)} 小时`;
export function CustomerMemoryMetrics({ contactId }: { contactId: string }) {
  return <MetricsContent key={contactId} contactId={contactId} />;
}
function MetricsContent({ contactId }: { contactId: string }) {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let latestRequest = 0;
    async function load() {
      const request = ++latestRequest;
      try {
        const response = await fetch(
          `/api/v1/ai/customer-memory/metrics?contact_id=${encodeURIComponent(contactId)}`,
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message ?? "统计暂不可用。");
        if (!controller.signal.aborted && request === latestRequest) {
          setData(value.data);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted && request === latestRequest) {
          setData(null);
          setError(e instanceof Error ? e.message : "统计暂不可用。");
        }
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [contactId, revision]);
  return (
    <section aria-label="记忆治理指标" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">记忆治理指标</h3>
        <Button variant="ghost" size="sm" onClick={() => setRevision((v) => v + 1)}>
          刷新指标
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        当前客户 · 全部历史 · 仅经理可见。用积压与纠正情况安排复核，不能把确认率当作事实正确率。
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !data ? (
        <p role="status" className="text-sm">
          正在统计…
        </p>
      ) : (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt>候选确认率</dt>
              <dd>
                {percent(data.confirmation_rate)}（{data.confirmed_count}/{data.decided_count}{" "}
                个已决定候选）
              </dd>
            </div>
            <div>
              <dt>候选驳回率</dt>
              <dd>
                {percent(data.rejection_rate)}（{data.rejected_count}/{data.decided_count}{" "}
                个已决定候选）
              </dd>
            </div>
            <div>
              <dt>确认耗时中位数</dt>
              <dd>
                {elapsed(data.median_confirmation_seconds)}（
                {data.confirmation_latency_sample_count} 个有效样本）
              </dd>
            </div>
            <div>
              <dt>超 7 天候选积压</dt>
              <dd>
                {data.pending_over_7d_count} / {data.pending_count} 个待确认候选
              </dd>
            </div>
            <div>
              <dt>冲突待审</dt>
              <dd>
                {data.open_conflict_count} 个 · 最长等待{" "}
                {elapsed(data.oldest_open_conflict_seconds)}
              </dd>
            </div>
            <div>
              <dt>冲突等待中位数</dt>
              <dd>
                {elapsed(data.median_open_conflict_seconds)} · 已解决耗时{" "}
                {elapsed(data.median_resolved_conflict_seconds)}
              </dd>
            </div>
            <div>
              <dt>报告事后纠正比例</dt>
              <dd>
                {percent(data.report_correction_rate)}（{data.corrected_report_count}/
                {data.used_report_count} 份有记忆回执的报告）
              </dd>
            </div>
            <div>
              <dt>独立拟稿事后纠正比例</dt>
              <dd>
                {percent(data.draft_correction_rate)}（{data.corrected_draft_count}/
                {data.used_draft_count} 份有直接记忆回执的草稿）
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            确认/驳回率仅以已决定候选为分母，合并项不计入。报告按根运行去重；多次读取同一报告不会重复计数，草稿按草稿
            ID 去重。只统计可核验读取回执；未记录不代表没有使用偏好。
          </p>
          <p className="text-xs text-muted-foreground">
            统计时间：{new Date(data.as_of).toLocaleString()}
            。处理上方建议和下方冲突，或核对报告旁的纠正记录后，刷新查看变化。
          </p>
        </>
      )}
    </section>
  );
}
