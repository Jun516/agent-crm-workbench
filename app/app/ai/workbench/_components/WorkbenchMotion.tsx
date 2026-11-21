"use client";

import { useEffect, useState, type ReactNode } from "react";

export function WorkbenchMessage({
  animate,
  kind,
  children,
}: {
  animate: boolean;
  kind: "task" | "result";
  children: ReactNode;
}) {
  const [entering, setEntering] = useState(animate);
  useEffect(() => {
    if (!entering || typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      if (preference.matches) setEntering(false);
    };
    // Consume a suppressed entrance so changing the preference does not replay it.
    const frame = requestAnimationFrame(onChange);
    preference.addEventListener("change", onChange);
    return () => {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", onChange);
    };
  }, [entering]);
  const Tag = kind === "task" ? "p" : "article";
  return (
    <Tag
      data-workbench-message={kind}
      data-entering={entering || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
      }}
      className={
        kind === "task"
          ? "workbench-message ml-auto w-fit max-w-[90%] rounded-xl bg-muted px-4 py-3 text-sm break-words whitespace-pre-wrap"
          : "workbench-message rounded-lg bg-surface p-4 text-sm leading-6 break-words whitespace-pre-wrap"
      }
    >
      {children}
    </Tag>
  );
}

export function WorkbenchRunStatus({ status }: { status: string }) {
  return (
    <span
      data-run-status={status}
      className="workbench-run-status inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      运行状态：{status}
    </span>
  );
}

export function statusFromWorkbenchEvent(eventType: string): string | undefined {
  switch (eventType) {
    // The POST acknowledges a queued run. The worker emits context_loaded after claiming it.
    case "context_loaded":
    case "run_resumed":
      return "running";
    case "run_completed":
      return "completed";
    case "run_partial":
      return "partial";
    case "run_failed":
      return "failed";
    case "run_cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

export function statusFromWorkbenchSnapshot(
  status: string,
  events: ReadonlyArray<{ event_type: string }>,
): string {
  const terminal = ["completed", "partial", "failed", "cancelled"];
  if (terminal.includes(status)) return status;
  for (const event of events) {
    const next = statusFromWorkbenchEvent(event.event_type);
    if (next && terminal.includes(next)) return next;
  }
  return status === "queued" &&
    events.some((event) => statusFromWorkbenchEvent(event.event_type) === "running")
    ? "running"
    : status;
}
