import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentCrmWorkbench } from "@/app/app/ai/workbench/_components/AgentCrmWorkbench";
import {
  statusFromWorkbenchEvent,
  statusFromWorkbenchSnapshot,
  WorkbenchMessage,
  WorkbenchRunStatus,
} from "@/app/app/ai/workbench/_components/WorkbenchMotion";

const agents = [
  {
    id: "a1",
    name: "情报员",
    description: "读取真实 CRM",
    builtinKey: "crm_intelligence",
    scenarios: [],
  },
];

function detail(id: string, task: string, status = "completed") {
  return {
    id,
    task,
    agent_id: "a1",
    mode: "inspect",
    status,
    final_text: status === "completed" ? `接口结果：${task}` : null,
    created_at: "2026-10-01T00:00:00Z",
    error_code: null as string | null,
    // POST persists this event while the run is still queued. It is not proof
    // that the worker has claimed or started processing the task.
    events: [
      {
        id: `${id}-started`,
        sequence: 1,
        event_type: "run_started",
        payload: {},
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    proposals: [],
    specialists: [],
  };
}

function json(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** A real ReadableStream, controlled by the test, never a network/model call. */
function eventStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let sequence = 1;
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    get closed() {
      return closed;
    },
    push(event_type: string, payload: Record<string, unknown> = {}) {
      sequence += 1;
      const event = {
        id: `event-${sequence}`,
        sequence,
        event_type,
        payload,
        created_at: "2026-10-01T00:00:00Z",
      };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
}

const records = new Map<string, ReturnType<typeof detail>>();
const submissions: Array<{ agentId: string; task: string; mode: string }> = [];
const reads: string[] = [];
let nextStatus: string;
let postResponse: Promise<Response> | undefined;
let stream: ReturnType<typeof eventStream> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  records.clear();
  submissions.length = 0;
  reads.length = 0;
  nextStatus = "completed";
  postResponse = undefined;
  stream = undefined;
  window.history.replaceState(null, "", "/app/ai/workbench");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST") reads.push(url);
      if (url === "/api/v1/ai/workbench/runs") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          submissions.push(body);
          const id = `run-${submissions.length}`;
          records.set(id, detail(id, body.task, nextStatus));
          return postResponse ?? json({ run_id: id });
        }
        return json([...records.values()]);
      }
      if (url.startsWith("/api/v1/ai/workbench/objects?")) return json([]);
      if (url.endsWith("/evaluation")) return json(null);
      const match = /^\/api\/v1\/ai\/workbench\/runs\/([^/]+)(.*)$/.exec(url);
      const record = match && records.get(match[1]!);
      if (match && record) {
        if (match[2]!.startsWith("/events?")) {
          // An unavailable stream uses the existing serial detail-poll fallback.
          return stream?.response ?? new Response(null, { status: 503 });
        }
        if (match[2] === "") return json(record);
      }
      throw new Error(`Unexpected offline request: ${url}`);
    }),
  );
});

afterEach(async () => {
  // Finish any deliberately held-open stream while the mocked fetch still exists.
  await act(async () => {
    if (stream && !stream.closed) {
      for (const record of records.values()) record.status = "cancelled";
      stream.close();
    }
  });
  cleanup();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function setup() {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(<AgentCrmWorkbench agents={agents} modelConfigured canCopy />);
  });
  return view!;
}

async function submit(task: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("给 Agent 的任务"), { target: { value: task } });
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "发送 Agent 任务" }));
  });
}

function message(kind: "task" | "result") {
  const node = screen
    .getByRole("region", { name: "Agent 对话" })
    .querySelector(`[data-workbench-message="${kind}"]`);
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

async function tick(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function finishEntry(node: HTMLElement) {
  // jsdom exposes WebkitAnimation styles without an AnimationEvent constructor,
  // so React's feature detection registers the prefixed event in this runtime.
  const eventName = "AnimationEvent" in window ? "animationend" : "webkitAnimationEnd";
  fireEvent(node, new Event(eventName, { bubbles: true }));
}

describe("once-only workbench message entry", () => {
  it("ends only its own entry animation and never replays on content or prop rerenders", () => {
    const { rerender } = render(
      <WorkbenchMessage kind="result" animate>
        <span>第一段</span>
      </WorkbenchMessage>,
    );
    const result = screen.getByText("第一段").closest("article")!;
    expect(result).toHaveAttribute("data-entering", "true");
    finishEntry(screen.getByText("第一段"));
    expect(result).toHaveAttribute("data-entering", "true");
    finishEntry(result);
    expect(result).not.toHaveAttribute("data-entering");
    rerender(
      <WorkbenchMessage kind="result" animate>
        第二段
      </WorkbenchMessage>,
    );
    expect(screen.getByText("第二段")).toBe(result);
    expect(result).not.toHaveAttribute("data-entering");
  });

  it("does not animate an existing message when a later render becomes eligible", () => {
    const { rerender } = render(
      <WorkbenchMessage kind="task" animate={false}>
        历史任务
      </WorkbenchMessage>,
    );
    const task = screen.getByText("历史任务");
    rerender(
      <WorkbenchMessage kind="task" animate>
        历史任务
      </WorkbenchMessage>,
    );
    expect(screen.getByText("历史任务")).toBe(task);
    expect(task).not.toHaveAttribute("data-entering");
  });

  it("consumes entry on the next frame when reduced motion is already requested", async () => {
    const preference = new EventTarget();
    Object.defineProperty(preference, "matches", { value: true });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => preference),
    );
    render(
      <WorkbenchMessage kind="result" animate>
        直接显示结果
      </WorkbenchMessage>,
    );
    expect(screen.getByText("直接显示结果")).toBeVisible();
    await tick(16);
    expect(screen.getByText("直接显示结果")).not.toHaveAttribute("data-entering");
  });

  it("finishes an active entry when reduced motion is enabled and never restarts it", () => {
    let reduced = false;
    const preference = new EventTarget();
    Object.defineProperty(preference, "matches", { get: () => reduced });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => preference),
    );
    const removeListener = vi.spyOn(preference, "removeEventListener");
    const { rerender } = render(
      <WorkbenchMessage kind="result" animate>
        动态结果
      </WorkbenchMessage>,
    );
    const result = screen.getByText("动态结果");
    expect(result).toHaveAttribute("data-entering", "true");
    act(() => {
      reduced = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(result).not.toHaveAttribute("data-entering");
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
    act(() => {
      reduced = false;
      preference.dispatchEvent(new Event("change"));
    });
    rerender(
      <WorkbenchMessage kind="result" animate>
        动态结果更新
      </WorkbenchMessage>,
    );
    expect(screen.getByText("动态结果更新")).toBe(result);
    expect(result).not.toHaveAttribute("data-entering");
  });

  it("keeps the task node through acknowledgement and enters the result only once", async () => {
    nextStatus = "queued";
    stream = eventStream();
    let acknowledge: (response: Response) => void = () => {};
    postResponse = new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
    const view = await setup();
    await submit("检查本周商机");
    const task = message("task");
    expect(task).toHaveAttribute("data-entering", "true");
    finishEntry(task);
    await act(async () => acknowledge(json({ run_id: "run-1" })));
    expect(message("task")).toBe(task);
    expect(task).not.toHaveAttribute("data-entering");

    await act(async () => stream!.push("context_loaded"));
    expect(screen.getByRole("status")).toHaveTextContent("运行状态：running");
    expect(message("task")).toBe(task);
    const record = records.get("run-1")!;
    record.status = "completed";
    record.final_text = "检查完成，有两项需要跟进";
    await act(async () => {
      stream!.push("run_completed");
      stream!.close();
    });
    const result = message("result");
    expect(result).toHaveAttribute("data-entering", "true");
    expect(result).toHaveTextContent(record.final_text);
    expect(message("task")).toBe(task);
    expect(task).not.toHaveAttribute("data-entering");
    finishEntry(result);
    view.rerender(<AgentCrmWorkbench agents={[...agents]} modelConfigured canCopy={false} />);
    expect(message("result")).toBe(result);
    expect(result).not.toHaveAttribute("data-entering");

    nextStatus = "completed";
    postResponse = undefined;
    await submit("下一件事");
    const previous = screen
      .getByRole("region", { name: "Agent 对话" })
      .querySelector('[aria-label="之前的运行"]')!;
    expect(previous).toHaveTextContent("检查本周商机");
    expect(previous).toHaveTextContent("检查完成，有两项需要跟进");
    expect(previous.querySelector("[data-entering]")).toBeNull();
    expect(message("task")).toHaveTextContent("下一件事");
    expect(message("task")).toHaveAttribute("data-entering", "true");
  });

  it("does not replay task or result entry on repeated polling snapshots", async () => {
    nextStatus = "awaiting_confirmation";
    await setup();
    await submit("需要人工核对");
    const task = message("task");
    finishEntry(task);
    const record = records.get("run-1")!;
    record.final_text = "请核对后再继续";
    await tick(2_000);
    const result = message("result");
    expect(result).toHaveAttribute("data-entering", "true");
    finishEntry(result);
    const readCount = reads.filter((url) => url === "/api/v1/ai/workbench/runs/run-1").length;
    record.final_text = "请核对后再继续（已刷新证据）";
    await tick(2_000);
    expect(reads.filter((url) => url === "/api/v1/ai/workbench/runs/run-1")).toHaveLength(
      readCount + 1,
    );
    expect(message("task")).toBe(task);
    expect(message("result")).toBe(result);
    expect(result).toHaveTextContent("请核对后再继续（已刷新证据）");
    expect(task).not.toHaveAttribute("data-entering");
    expect(result).not.toHaveAttribute("data-entering");
  });

  it.each(["history", "deep-link"])("never enters messages loaded through %s", async (source) => {
    records.set("old", detail("old", "之前的任务"));
    if (source === "deep-link") window.history.replaceState(null, "", "/app/ai/workbench?run=old");
    await setup();
    if (source === "history") {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /^运行详情/ })));
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /之前的任务.*completed/ })),
      );
    }
    expect(message("task")).toHaveTextContent("之前的任务");
    expect(message("result")).toHaveTextContent("接口结果：之前的任务");
    expect(message("task")).not.toHaveAttribute("data-entering");
    expect(message("result")).not.toHaveAttribute("data-entering");
    expect(submissions).toHaveLength(0);
  });
});

describe("server-driven workbench status", () => {
  it.each([
    ["context_loaded", "running"],
    ["run_resumed", "running"],
    ["run_completed", "completed"],
    ["run_partial", "partial"],
    ["run_failed", "failed"],
    ["run_cancelled", "cancelled"],
  ])("maps the canonical %s event to %s", (eventType, status) => {
    expect(statusFromWorkbenchEvent(eventType)).toBe(status);
  });

  it.each(["run_started", "tool_completed", "specialist_failed", "model_decision", "heartbeat"])(
    "does not invent a run status from %s",
    (eventType) => expect(statusFromWorkbenchEvent(eventType)).toBeUndefined(),
  );

  it.each([
    ["queued", ["run_started"], "queued"],
    ["queued", ["run_started", "context_loaded"], "running"],
    ["queued", ["run_resumed"], "running"],
    ["awaiting_confirmation", ["context_loaded", "run_resumed"], "awaiting_confirmation"],
    ["running", ["tool_completed", "specialist_failed"], "running"],
    ["running", ["run_failed"], "failed"],
    ["queued", ["run_cancelled"], "cancelled"],
    ["running", ["run_completed"], "completed"],
    ["running", ["run_partial"], "partial"],
  ] as const)("reconciles a %s snapshot with %j as %s", (status, eventTypes, expected) => {
    expect(
      statusFromWorkbenchSnapshot(
        status,
        eventTypes.map((event_type) => ({ event_type })),
      ),
    ).toBe(expected);
  });

  it.each(["completed", "partial", "failed", "cancelled"])(
    "preserves a persisted %s snapshot despite older or conflicting events",
    (status) => {
      expect(
        statusFromWorkbenchSnapshot(status, [
          { event_type: "context_loaded" },
          { event_type: "run_resumed" },
          { event_type: "run_completed" },
          { event_type: "run_failed" },
        ]),
      ).toBe(status);
    },
  );

  it.each(["failed", "cancelled", "completed", "partial"])(
    "observes %s already present in an active detail snapshot without waiting for stream replay",
    async (terminal) => {
      nextStatus = "queued";
      let acknowledge: (response: Response) => void = () => {};
      postResponse = new Promise<Response>((resolve) => {
        acknowledge = resolve;
      });
      await setup();
      await submit("事件先于状态读取完成");
      const record = records.get("run-1")!;
      record.events.push({
        id: "terminal-event",
        sequence: 2,
        event_type: `run_${terminal}`,
        payload: { code: "worker_failed" },
        created_at: "2026-10-01T00:00:01Z",
      });
      await act(async () => acknowledge(json({ run_id: record.id })));
      // Both detail reads return the old queued row plus its newer terminal event.
      expect(record.status).toBe("queued");
      expect(screen.getByRole("status")).toHaveTextContent(`运行状态：${terminal}`);
      if (terminal === "failed") expect(screen.getByText("运行错误：worker_failed")).toBeVisible();
      expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled();
      expect(screen.getByLabelText("给 Agent 的任务")).toBeEnabled();
      expect(reads.some((url) => url.includes("/events?"))).toBe(false);
      expect(submissions).toHaveLength(1);
      await tick(10_000);
      expect(screen.getByRole("status")).toHaveTextContent(`运行状态：${terminal}`);
    },
  );

  it("reflects a terminal status immediately without a timer-driven intermediate state", () => {
    const { rerender } = render(<WorkbenchRunStatus status="running" />);
    const status = screen.getByText("运行状态：running");
    const timers = vi.getTimerCount();
    rerender(<WorkbenchRunStatus status="failed" />);
    expect(screen.getByText("运行状态：failed")).toBe(status);
    expect(status).toHaveAttribute("data-run-status", "failed");
    rerender(<WorkbenchRunStatus status="cancelled" />);
    expect(status).toHaveAttribute("data-run-status", "cancelled");
    expect(vi.getTimerCount()).toBe(timers);
  });

  it.each(["failed", "cancelled", "partial", "completed"])(
    "shows SSE %s while the stream is still open and ignores elapsed time and stale events",
    async (terminal) => {
      nextStatus = "queued";
      stream = eventStream();
      await setup();
      await submit("等待服务器状态");
      expect(screen.getByRole("status")).toHaveTextContent("运行状态：queued");
      await tick(60_000);
      expect(screen.getByRole("status")).toHaveTextContent("运行状态：queued");
      await act(async () => stream!.push("run_started"));
      expect(screen.getByRole("status")).toHaveTextContent("运行状态：queued");
      await act(async () => stream!.push("context_loaded"));
      expect(screen.getByRole("status")).toHaveTextContent("运行状态：running");
      await act(async () => stream!.push("tool_completed"));
      expect(screen.getByRole("status")).toHaveTextContent("运行状态：running");

      const readCount = reads.filter((url) => url === "/api/v1/ai/workbench/runs/run-1").length;
      await act(async () => stream!.push(`run_${terminal}`, { code: "provider_unavailable" }));
      expect(stream!.closed).toBe(false);
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(`运行状态：${terminal}`);
      expect(status.querySelector("[data-run-status]")).toHaveAttribute(
        "data-run-status",
        terminal,
      );
      expect(reads.filter((url) => url === "/api/v1/ai/workbench/runs/run-1")).toHaveLength(
        readCount,
      );
      if (terminal === "failed")
        expect(screen.getByText("运行错误：provider_unavailable")).toBeVisible();
      expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();

      await act(async () => stream!.push("run_resumed"));
      expect(status).toHaveTextContent(`运行状态：${terminal}`);
      records.get("run-1")!.status = terminal;
      await act(async () => stream!.close());
      expect(screen.getByRole("status")).toHaveTextContent(`运行状态：${terminal}`);
    },
  );

  it.each(["failed", "cancelled"])("does not delay or animate a %s result", async (terminal) => {
    nextStatus = terminal;
    let acknowledge: (response: Response) => void = () => {};
    postResponse = new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
    await setup();
    await submit("未完成的任务");
    records.get("run-1")!.final_text = "任务没有执行完成";
    await act(async () => acknowledge(json({ run_id: "run-1" })));
    expect(message("result")).toHaveTextContent("任务没有执行完成");
    expect(message("result")).not.toHaveAttribute("data-entering");
    expect(screen.getByRole("status")).toHaveTextContent(`运行状态：${terminal}`);
  });
});

describe("composer and scroll behavior with motion", () => {
  it("preserves Shift+Enter and IME composition, then submits Enter exactly once", async () => {
    await setup();
    const input = screen.getByLabelText("给 Agent 的任务");
    fireEvent.change(input, { target: { value: "中文任务\n第二行" } });
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(input).toHaveValue("中文任务\n第二行");
    expect(submissions).toHaveLength(0);
    await act(async () => {
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(submissions).toEqual([{ agentId: "a1", task: "中文任务\n第二行", mode: "inspect" }]);
    expect(input).toHaveValue("");
    expect(input).toBeEnabled();
    expect(screen.getByRole("form", { name: "发送 Agent 任务" })).toHaveClass("shrink-0");
  });

  it("does not pull an operator reading earlier messages down when the live result arrives", async () => {
    await setup();
    await submit("之前的任务");
    nextStatus = "queued";
    stream = eventStream();
    await submit("新的任务");
    const region = screen.getByRole("region", { name: "Agent 对话" });
    let height = 1_000;
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 200 },
    });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    const record = records.get("run-2")!;
    record.status = "completed";
    record.final_text = "新的任务完成了";
    height = 1_500;
    await act(async () => {
      stream!.push("run_completed");
      stream!.close();
    });
    expect(within(region).getByText("接口结果：之前的任务")).toBeVisible();
    expect(message("result")).toHaveTextContent("新的任务完成了");
    expect(message("result")).toHaveAttribute("data-entering", "true");
    expect(region.scrollTop).toBe(100);
    expect(screen.getByLabelText("给 Agent 的任务")).toBeEnabled();
  });

  it.each([48, 49, 700])(
    "preserves the scroll opt-in at %i pixels from the bottom when polling delivers a result",
    async (distance) => {
      const record = detail("history", "进行中的历史任务", "running");
      records.set(record.id, record);
      window.history.replaceState(null, "", "/app/ai/workbench?run=history");
      await setup();
      const region = screen.getByRole("region", { name: "Agent 对话" });
      let height = 1_000;
      Object.defineProperties(region, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, value: 200 },
      });
      region.scrollTop = height - 200 - distance;
      fireEvent.scroll(region);
      const readingPosition = region.scrollTop;
      const task = message("task");

      record.status = "awaiting_confirmation";
      await tick(2_000);
      expect(screen.getByRole("status")).toHaveTextContent("awaiting_confirmation");
      expect(region.scrollTop).toBe(distance <= 48 ? height : readingPosition);
      expect(message("task")).toBe(task);
      expect(task).not.toHaveAttribute("data-entering");

      height = 1_500;
      record.status = "completed";
      record.final_text = "服务器返回的新结果";
      await tick(2_000);
      expect(within(region).getByText("服务器返回的新结果")).toBeVisible();
      expect(region.scrollTop).toBe(distance <= 48 ? height : readingPosition);
      expect(message("result")).not.toHaveAttribute("data-entering");
      expect(submissions).toHaveLength(0);
    },
  );
});
