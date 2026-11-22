"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MotionDisclosure } from "@/components/ui/motion-disclosure";
import { randomId } from "@/lib/random-id";
import { CustomerMemoryCandidates } from "./CustomerMemoryCandidates";
import { CustomerMemoryMetrics } from "./CustomerMemoryMetrics";
import {
  MEMORY_TYPE_LABELS,
  type CustomerMemoryView,
  type MemoryCapabilities,
  type MemoryConflictView,
} from "@/lib/ai/customer-memory/view";

async function json(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "客户记忆暂不可用，请刷新。");
  return value;
}
export function CustomerMemoryPanel({
  contactId,
  readOnly = false,
}: {
  contactId: string;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<CustomerMemoryView[]>([]);
  const [conflicts, setConflicts] = useState<MemoryConflictView[]>([]);
  const [caps, setCaps] = useState<MemoryCapabilities>({
    can_confirm: false,
    can_arbitrate: false,
  });
  const [body, setBody] = useState(""),
    [type, setType] = useState("communication_preference");
  const [expiry, setExpiry] = useState(""),
    [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [settled, setSettled] = useState<Record<string, boolean>>({});
  const [queueRevision, setQueueRevision] = useState(0);
  const [editing, setEditing] = useState<{
    row: CustomerMemoryView;
    action: "review" | "retire";
  } | null>(null);
  const [reason, setReason] = useState(""),
    [reviewDate, setReviewDate] = useState("");
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [conflictsCursor, setConflictsCursor] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState<"memories" | "conflicts" | null>(null);
  const requestKey = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++loadSequence.current;
      const value = await json(
        await fetch(`/api/v1/ai/customer-memory?contact_id=${encodeURIComponent(contactId)}`, {
          signal,
        }),
      );
      if (signal?.aborted || sequence !== loadSequence.current) return;
      setRows(value.data);
      setConflicts(value.meta?.conflicts ?? []);
      setCaps({
        can_confirm: Boolean(value.meta?.can_confirm),
        can_arbitrate: Boolean(value.meta?.can_arbitrate),
      });
      setMore(Boolean(value.meta?.has_more || value.meta?.conflicts_has_more));
      setCursor(value.meta?.cursor ?? null);
      setConflictsCursor(value.meta?.conflicts_cursor ?? null);
    },
    [contactId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => load(controller.signal))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [load]);
  async function loadMore(kind: "memories" | "conflicts") {
    const next = kind === "memories" ? cursor : conflictsCursor;
    if (!next || loadingPage) return;
    setLoadingPage(kind);
    const sequence = ++loadSequence.current;
    try {
      const params = new URLSearchParams({ contact_id: contactId });
      params.set(kind === "memories" ? "cursor" : "conflicts_cursor", next);
      const value = await json(await fetch(`/api/v1/ai/customer-memory?${params}`));
      if (sequence !== loadSequence.current) return;
      if (kind === "memories") {
        setRows((old) => [
          ...old,
          ...value.data.filter((row: CustomerMemoryView) => !old.some((r) => r.id === row.id)),
        ]);
        setCursor(value.meta?.cursor ?? null);
        setMore(Boolean(value.meta?.has_more || conflictsCursor));
      } else {
        setConflicts((old) => [
          ...old,
          ...value.meta.conflicts.filter(
            (row: MemoryConflictView) => !old.some((r) => r.id === row.id),
          ),
        ]);
        setConflictsCursor(value.meta?.conflicts_cursor ?? null);
        setMore(Boolean(cursor || value.meta?.conflicts_has_more));
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载后续记录失败。");
    } finally {
      setLoadingPage(null);
    }
  }
  async function mutate(url: string, method: string, payload: unknown) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await json(
        await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      await load();
      setQueueRevision((v) => v + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求未完成，请刷新后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const lifecycle = (
    row: CustomerMemoryView,
    action: string,
    extra: Record<string, unknown> = {},
  ) =>
    mutate("/api/v1/ai/customer-memory/lifecycle", "PATCH", {
      contact_id: contactId,
      memory_id: row.id,
      expected_revision: row.policy_revision,
      action,
      ...extra,
    });
  return (
    <section id="customer-memory" className="space-y-4 rounded-xl border p-4" aria-label="客户记忆">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">客户记忆</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          刷新记忆
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        已确认的偏好与约束才会用于任务；订单、金额与阶段以 CRM
        业务记录为准。公司产品、价格与承诺请放入知识库。
      </p>
      {!readOnly && (
        <form
          className="space-y-2 rounded-lg border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            requestKey.current ??= randomId();
            const category =
              type === "communication_preference" ? "communication_context" : "preference";
            const input = {
              contact_id: contactId,
              request_key: requestKey.current,
              category,
              memory_type: type,
              body,
              ...(type === "temporary_request" && expiry
                ? { ttl_expires_at: new Date(expiry).toISOString() }
                : {}),
            };
            const endpoint = caps.can_confirm
              ? "/api/v1/ai/customer-memory"
              : "/api/v1/ai/customer-memory/candidates";
            if (
              await mutate(endpoint, "POST", {
                ...input,
                ...(caps.can_confirm
                  ? { confirmed: true, locked: type !== "temporary_request" && locked }
                  : {}),
              })
            ) {
              requestKey.current = null;
              setBody("");
              setNotice(caps.can_confirm ? "已确认并保存。" : "已提交候选，等待客户负责人确认。");
            }
          }}
        >
          <h3 className="text-sm font-medium">显式记住</h3>
          <label className="block text-sm">
            记忆类型
            <select
              className="mt-1 w-full rounded-md border bg-background p-2"
              value={type}
              disabled={busy}
              onChange={(e) => {
                setType(e.target.value);
                setLocked(false);
                requestKey.current = null;
              }}
            >
              {Object.entries(MEMORY_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            记忆内容
            <Input
              value={body}
              maxLength={2000}
              disabled={busy}
              onChange={(e) => {
                setBody(e.target.value);
                requestKey.current = null;
              }}
            />
          </label>
          {type === "temporary_request" && (
            <label className="block text-sm">
              到期时间（本地时区）
              <Input
                type="datetime-local"
                value={expiry}
                required
                disabled={busy}
                onChange={(e) => {
                  setExpiry(e.target.value);
                  requestKey.current = null;
                }}
              />
            </label>
          )}
          {caps.can_confirm && type !== "temporary_request" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={locked}
                disabled={busy}
                onChange={(e) => {
                  setLocked(e.target.checked);
                  requestKey.current = null;
                }}
              />
              锁定核心约束，修改前须显式解锁
            </label>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={busy || !body.trim() || (type === "temporary_request" && !expiry)}
          >
            {caps.can_confirm ? "确认并保存" : "提出候选"}
          </Button>
        </form>
      )}
      <CustomerMemoryCandidates
        key={`candidates:${contactId}:${queueRevision}`}
        contactId={contactId}
        capabilities={caps}
        readOnly={readOnly}
        onChanged={() => void load().catch((e) => setError(e.message))}
      />
      {caps.can_arbitrate && (
        <CustomerMemoryMetrics key={`metrics:${contactId}:${queueRevision}`} contactId={contactId} />
      )}
      <h3 className="font-medium">已确认的客户记忆</h3>
      {!rows.length && (
        <p className="text-sm text-muted-foreground">
          暂无已确认记忆，可从上方提出建议或显式记住。
        </p>
      )}
      {rows
        .filter((row) => !row.deleted_at)
        .map((row) => (
          <article key={row.id} className="space-y-2 rounded-md bg-muted p-3 text-sm">
            <p className="whitespace-pre-wrap">{row.body}</p>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{MEMORY_TYPE_LABELS[row.memory_type]}</span>
              <span>{row.risk_level === "high" ? "高风险" : "中风险"}</span>
              {row.locked && <span>已锁定</span>}
              {row.expired && <span>已到期 · 停止使用</span>}
              {row.needs_review && <span>待复核 · 可能已过时，业务字段优先</span>}
            </div>
            {row.ttl_expires_at && <p>有效至：{new Date(row.ttl_expires_at).toLocaleString()}</p>}
            {row.review_due_at && <p>下次复核：{new Date(row.review_due_at).toLocaleString()}</p>}
            <p className="text-xs break-all text-muted-foreground">
              记忆 ID：{row.id} · 确认时间：{new Date(row.confirmed_at).toLocaleString()}
            </p>
            {row.review_reason?.startsWith("human_review:") && (
              <p>人工复核说明：{row.review_reason.slice(13)}</p>
            )}
            {row.supersedes && <p className="text-xs break-all">替换自：{row.supersedes}</p>}
            {row.evidence_conversation_id && (
              <Link className="underline" href={`/app/inbox?id=${row.evidence_conversation_id}`}>
                查看证据会话
              </Link>
            )}
            {!readOnly && caps.can_confirm && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || row.expired || row.retention_policy === "ephemeral"}
                  onClick={() => void lifecycle(row, "set_lock", { locked: !row.locked })}
                >
                  {row.locked ? "显式解锁" : "锁定记忆"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || row.expired}
                  onClick={() => {
                    setEditing({ row, action: "review" });
                    setReason("");
                    setReviewDate("");
                  }}
                >
                  人工复核
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || row.locked}
                  onClick={() => {
                    setEditing({ row, action: "retire" });
                    setReason("");
                  }}
                >
                  停用此记忆
                </Button>
              </div>
            )}
            {editing?.row.id === row.id && (
              <form
                className="space-y-2 border-t pt-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await lifecycle(row, editing.action, {
                      reason,
                      ...(editing.action === "review"
                        ? { review_due_at: reviewDate ? new Date(reviewDate).toISOString() : null }
                        : {}),
                    })
                  )
                    setEditing(null);
                }}
              >
                <label className="block">
                  {editing.action === "retire" ? "停用原因" : "人工复核说明"}
                  <Input
                    value={reason}
                    maxLength={800}
                    required
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                {editing.action === "review" && (
                  <label className="block">
                    下次复核（可留空，本地时区）
                    <Input
                      type="datetime-local"
                      value={reviewDate}
                      onChange={(e) => setReviewDate(e.target.value)}
                    />
                  </label>
                )}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
                    提交{editing.action === "review" ? "复核" : "停用"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    取消
                  </Button>
                </div>
              </form>
            )}
          </article>
        ))}
      {conflicts.length > 0 && (
        <section aria-label="记忆冲突待审" className="space-y-3">
          <h3 className="font-medium">记忆冲突待审</h3>
          {conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              enabled={!readOnly && caps.can_arbitrate}
              busy={busy}
              mutate={mutate}
              contactId={contactId}
            />
          ))}
        </section>
      )}
      <MotionDisclosure title="同步与清理状态（运维）">
        <p className="mb-2 text-sm text-muted-foreground">
          SQL 是确认记忆真源；可选 Mem0 只用于检索排序。未知写入先核对结果，不能重复 ADD。
        </p>
        {rows.map((row) => (
          <div key={row.id} className="space-y-2 border-t py-2 text-sm">
            <p className="break-all">
              {row.id} · {row.sync_state} ·{" "}
              {row.deleted_at
                ? row.remote_deleted_at
                  ? "已停止使用 · 外部清理已验证"
                  : "已停止使用 · 外部清理待验证"
                : "本地已确认"}
            </p>
            {!readOnly &&
              caps.can_arbitrate &&
              ["unknown", "in_flight"].includes(row.write_outcome) && (
                <div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settled[row.id] ?? false}
                      onChange={(e) => setSettled({ ...settled, [row.id]: e.target.checked })}
                    />
                    我已在 Mem0 服务确认先前请求已结束
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !settled[row.id]}
                    onClick={() =>
                      void mutate("/api/v1/ai/customer-memory", "PATCH", {
                        id: row.id,
                        remote_request_settled: true,
                      })
                    }
                  >
                    核对结果，不重复写入
                  </Button>
                </div>
              )}
          </div>
        ))}
      </MotionDisclosure>
      {more && <p className="text-sm">当前展示部分记录，可继续加载；刷新会回到第一页。</p>}
      <div className="flex flex-wrap gap-2">
        {cursor && (
          <Button
            variant="outline"
            size="sm"
            disabled={loadingPage !== null}
            onClick={() => void loadMore("memories")}
          >
            加载更多记忆记录
          </Button>
        )}
        {conflictsCursor && (
          <Button
            variant="outline"
            size="sm"
            disabled={loadingPage !== null}
            onClick={() => void loadMore("conflicts")}
          >
            加载更多冲突
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
function ConflictCard({
  conflict,
  enabled,
  busy,
  mutate,
  contactId,
}: {
  conflict: MemoryConflictView;
  enabled: boolean;
  busy: boolean;
  contactId: string;
  mutate: (url: string, method: string, payload: unknown) => Promise<boolean>;
}) {
  const [reason, setReason] = useState(""),
    [resolution, setResolution] = useState("");
  return (
    <article className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm">
      <p>
        {conflict.kind === "l0_l1"
          ? `业务字段 ${conflict.business_field ?? ""} 与客户记忆可能冲突，业务表优先。`
          : conflict.kind === "l1_l1"
            ? "两条确认记忆可能相互矛盾。"
            : "候选与确认记忆冲突，请在上方候选卡片处理。"}
      </p>
      <p>
        {conflict.memory_body}
        {conflict.memory_locked ? "（已锁定）" : ""}
      </p>
      {conflict.other_body && (
        <p>
          {conflict.other_body}
          {conflict.other_locked ? "（已锁定）" : ""}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        发现于 {new Date(conflict.created_at).toLocaleString()} ·
        需要停用锁定项时，请先在上方显式解锁。
      </p>
      {enabled && conflict.kind !== "l2_l1" && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await mutate("/api/v1/ai/customer-memory/lifecycle", "PATCH", {
              action: "resolve_conflict",
              contact_id: contactId,
              memory_id: conflict.memory_id,
              expected_revision: conflict.memory_revision,
              conflict_id: conflict.id,
              resolution,
              reason,
              ...(conflict.other_revision
                ? { other_expected_revision: conflict.other_revision }
                : {}),
            });
          }}
        >
          <select
            aria-label="冲突裁决"
            className="w-full rounded-md border bg-background p-2"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            required
          >
            <option value="">选择明确处理方式</option>
            <option value="keep_memory">
              保留第一条{conflict.kind === "l1_l1" ? "，停用另一条" : "，说明适用情景"}
            </option>
            {conflict.kind === "l1_l1" ? (
              <>
                <option value="keep_other">保留另一条，停用第一条</option>
                <option value="keep_both">两条均保留，明确各自适用情景</option>
              </>
            ) : (
              <option value="retire_memory">停用记忆，保留业务事实</option>
            )}
          </select>
          <label className="block">
            裁决原因与适用情景
            <Input
              value={reason}
              required
              maxLength={800}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !resolution || !reason.trim()}
          >
            提交经理裁决
          </Button>
        </form>
      )}
    </article>
  );
}
