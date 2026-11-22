"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MotionDisclosure } from "@/components/ui/motion-disclosure";
import { CustomerMemoryActivity } from "./CustomerMemoryActivity";
import {
  MEMORY_TYPE_LABELS,
  localMemoryDateValue,
  type MemoryCandidateView,
  type MemoryCapabilities,
} from "@/lib/ai/customer-memory/view";

async function readJson(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "客户记忆暂不可用，请重试。");
  return data;
}
export function CustomerMemoryCandidates({
  contactId,
  runId,
  readOnly = false,
  capabilities,
  onChanged,
}: {
  contactId: string;
  runId?: string;
  readOnly?: boolean;
  capabilities?: MemoryCapabilities;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<MemoryCandidateView[]>([]);
  const [authority, setAuthority] = useState<MemoryCapabilities>({
    can_confirm: false,
    can_arbitrate: false,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const paged = useRef(false);
  const loadSequence = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    async (signal?: AbortSignal, next?: string) => {
      const sequence = ++loadSequence.current;
      if (next) paged.current = true;
      const params = new URLSearchParams({ contact_id: contactId });
      if (next) params.set("cursor", next);
      const value = await readJson(
        await fetch(`/api/v1/ai/customer-memory/candidates?${params}`, { signal }),
      );
      if (!signal?.aborted && sequence === loadSequence.current) {
        setRows((old) =>
          next
            ? [
                ...old,
                ...value.data.filter(
                  (row: MemoryCandidateView) => !old.some((r) => r.id === row.id),
                ),
              ]
            : value.data,
        );
        paged.current = Boolean(next);
        setMore(Boolean(value.meta?.has_more));
        setCursor(value.meta?.cursor ?? null);
        setPartial(value.meta?.coverage === "partial");
        setError("");
        setLoading(false);
      }
    },
    [contactId],
  );
  useEffect(() => {
    const controller = new AbortController();
    const fetchAll = async () => {
      await load(controller.signal);
      if (!capabilities) {
        const value = await readJson(
          await fetch(`/api/v1/ai/customer-memory?contact_id=${encodeURIComponent(contactId)}`, {
            signal: controller.signal,
          }),
        );
        if (!controller.signal.aborted)
          setAuthority({
            can_confirm: Boolean(value.meta?.can_confirm),
            can_arbitrate: Boolean(value.meta?.can_arbitrate),
          });
      }
    };
    const report = (e: unknown) => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(e instanceof Error ? e.message : "候选暂不可用");
      }
    };
    void fetchAll().catch(report);
    const timer = setInterval(() => {
      if (!paged.current && document.visibilityState === "visible")
        void load(controller.signal).catch(report);
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, capabilities, contactId, refresh]);
  const permissions = capabilities ?? authority;
  return (
    <section
      aria-label="建议确认的记忆"
      className="space-y-3 rounded-xl border border-primary/20 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">建议确认的记忆</h3>
        <Button variant="ghost" size="sm" onClick={() => setRefresh((v) => v + 1)}>
          刷新建议
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        以下是待确认假说，尚未用于客户画像。负责人可确认，同事可提议，冲突由经理处理。
      </p>
      {runId && (
        <p className="text-xs text-muted-foreground">
          这是该客户当前的待确认队列，也包含本次报告前已有的建议。
        </p>
      )}
      <CustomerMemoryActivity contactId={contactId} readOnly={readOnly} />
      {loading && (
        <p role="status" className="text-sm">
          正在读取建议…
        </p>
      )}
      {!loading && !rows.length && !error && !partial && (
        <p className="text-sm text-muted-foreground">
          暂未发现待确认建议。后台整理结果会自动更新；这不代表客户没有相关偏好。
        </p>
      )}
      {rows.map((row) => (
        <CandidateCard
          key={`${row.id}:${row.revision_token}`}
          row={row}
          rows={rows}
          capabilities={permissions}
          readOnly={readOnly}
          contactId={contactId}
          onChanged={async () => {
            await load();
            onChanged?.();
          }}
        />
      ))}
      {partial && (
        <p className="text-sm text-muted-foreground">
          权限筛选尚未检查完后续建议，当前空页不代表没有候选。
        </p>
      )}
      {more && cursor && (
        <Button
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            try {
              await load(undefined, cursor);
            } catch (e) {
              setError(e instanceof Error ? e.message : "加载后续建议失败。");
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          {loadingMore ? "正在检查后续建议…" : "加载更多建议"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {runId && (
        <Link className="text-sm underline" href={`/app/contacts/${contactId}#customer-memory`}>
          查看该客户全部记忆与冲突
        </Link>
      )}
    </section>
  );
}
function CandidateCard({
  row,
  rows,
  contactId,
  capabilities,
  readOnly,
  onChanged,
}: {
  row: MemoryCandidateView;
  rows: MemoryCandidateView[];
  contactId: string;
  capabilities: MemoryCapabilities;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const [edit, setEdit] = useState(false),
    [reject, setReject] = useState(false),
    [busy, setBusy] = useState(false);
  const [body, setBody] = useState(row.body),
    [reason, setReason] = useState(""),
    [until, setUntil] = useState("");
  const [expiry, setExpiry] = useState(
    row.ttl_expires_at ? localMemoryDateValue(row.ttl_expires_at) : "",
  );
  const [replacement, setReplacement] = useState(""),
    [merge, setMerge] = useState("");
  const [error, setError] = useState("");
  const conflict = row.conflicts.length > 0;
  const canDecide = !readOnly && capabilities.can_confirm;
  const canConfirm = canDecide && (!conflict || capabilities.can_arbitrate);
  async function decide(action: string, extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await readJson(
        await fetch("/api/v1/ai/customer-memory/candidates", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            id: row.id,
            revision_token: row.revision_token,
            ...extra,
          }),
        }),
      );
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "处理未完成，请刷新。");
    } finally {
      setBusy(false);
    }
  }
  const confirm = () => {
    const policy = {
      ...(replacement ? { supersedes: replacement } : {}),
      ...(row.memory_type === "temporary_request" && expiry
        ? { ttl_expires_at: new Date(expiry).toISOString() }
        : {}),
    };
    void decide("confirm", {
      ...(edit ? { body } : {}),
      ...(Object.keys(policy).length ? { policy } : {}),
    });
  };
  return (
    <article className="space-y-3 rounded-lg bg-muted/50 p-3" aria-label={`候选：${row.body}`}>
      <div className="flex flex-wrap gap-2 text-xs">
        <span>{MEMORY_TYPE_LABELS[row.memory_type] ?? row.memory_type}</span>
        <span>{row.risk_level === "high" ? "高风险 · 人工确认" : "中风险 · 人工确认"}</span>
        <span>
          {row.model_confidence === null
            ? "人工提议"
            : `模型置信度 ${Math.round(Number(row.model_confidence) * 100)}%（非事实保证）`}
        </span>
        <time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString()}</time>
      </div>
      {edit ? (
        <label className="block space-y-1 text-sm">
          改写记忆内容
          <textarea
            className="w-full rounded-md border bg-background p-2"
            value={body}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{row.body}</p>
      )}
      {row.evidence.map((e) => (
        <blockquote key={e.id} className="space-y-1 border-l-2 pl-3 text-sm">
          <p className="whitespace-pre-wrap">“{e.excerpt}”</p>
          <time className="text-xs text-muted-foreground" dateTime={e.observed_at}>
            {new Date(e.observed_at).toLocaleString()}
          </time>
          {e.conversation_id && (
            <Link className="ml-2 underline" href={`/app/inbox?id=${e.conversation_id}`}>
              查看来源会话
            </Link>
          )}
        </blockquote>
      ))}
      {row.memory_type === "temporary_request" && (
        <label className="block text-sm">
          到期时间（本地时区）
          <Input
            type="datetime-local"
            value={expiry}
            disabled={!canDecide || busy}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
      )}
      {conflict && (
        <div className="space-y-2 text-sm">
          <p className="text-amber-700 dark:text-amber-300">
            与已确认记忆冲突。经理选择明确替换；锁定项需要先显式解锁。
          </p>
          <Link className="underline" href={`/app/contacts/${contactId}#customer-memory`}>
            查看并处理已确认记忆
          </Link>
          {canConfirm && (
            <select
              aria-label="选择替换的记忆"
              className="w-full rounded-md border bg-background p-2"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            >
              <option value="">请选择被替换记忆</option>
              {row.conflicts.map((c) => (
                <option key={c.id} value={c.memory_id}>
                  {c.memory_id}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {canDecide && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              busy ||
              !canConfirm ||
              !body.trim() ||
              (conflict && !replacement) ||
              (row.memory_type === "temporary_request" && !expiry)
            }
            onClick={confirm}
          >
            {edit ? "改写后确认" : "同意并确认"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEdit((v) => !v)}>
            {edit ? "取消改写" : "改写"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReject((v) => !v)}>
            驳回
          </Button>
        </div>
      )}
      {reject && canDecide && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("reject", { reason, rejected_until: new Date(until).toISOString() });
          }}
        >
          <label className="block text-sm">
            驳回原因
            <Input
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            暂停同类建议至（本地时区）
            <Input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              required
            />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !reason.trim() || !until}
          >
            确认驳回
          </Button>
        </form>
      )}
      {canDecide && rows.length > 1 && (
        <MotionDisclosure title="合并重复候选">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="合并到候选"
              className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
              value={merge}
              onChange={(e) => setMerge(e.target.value)}
            >
              <option value="">选择保留项，证据将合并</option>
              {rows
                .filter(
                  (r) =>
                    r.id !== row.id &&
                    r.memory_type === row.memory_type &&
                    r.attribute_key === row.attribute_key,
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.body}
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !merge}
              onClick={() => void decide("merge", { target_id: merge })}
            >
              合并
            </Button>
          </div>
        </MotionDisclosure>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
