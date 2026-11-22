import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CustomerMemoryMetrics } from "./CustomerMemoryMetrics";
const metrics = {
  as_of: "2026-11-13T00:00:00Z",
  confirmed_count: 2,
  rejected_count: 1,
  decided_count: 3,
  confirmation_rate: 2 / 3,
  rejection_rate: 1 / 3,
  confirmation_latency_sample_count: 2,
  median_confirmation_seconds: 7200,
  pending_count: 4,
  pending_over_7d_count: 2,
  open_conflict_count: 1,
  oldest_open_conflict_seconds: 28800,
  median_open_conflict_seconds: 28800,
  median_resolved_conflict_seconds: 3600,
  used_report_count: 2,
  corrected_report_count: 1,
  report_correction_rate: 0.5,
  used_draft_count: 0,
  corrected_draft_count: 0,
  draft_correction_rate: null,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("memory governance metrics", () => {
  it("shows decision denominators and missing samples, then refreshes after human work", async () => {
    let refreshed = false;
    const fetcher = vi.fn(async () =>
      response({ data: { ...metrics, pending_over_7d_count: refreshed ? 1 : 2 } }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryMetrics contactId="contact-1" />);
    await screen.findByText("66.7%（2/3 个已决定候选）");
    expect(screen.getByText("2 / 4 个待确认候选")).toBeVisible();
    expect(screen.getByText("暂无样本（0/0 份有直接记忆回执的草稿）")).toBeVisible();
    expect(screen.getByText("50.0%（1/2 份有记忆回执的报告）")).toBeVisible();
    refreshed = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新指标" }));
    await screen.findByText("1 / 4 个待确认候选");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("contact_id=contact-1"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("removes old figures when renewed access is denied", async () => {
    const fetcher = vi.fn(async () => response({ data: metrics }));
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryMetrics contactId="contact-1" />);
    await screen.findByText("66.7%（2/3 个已决定候选）");
    fetcher.mockImplementation(async () => response({ error: { message: "当前权限不足" } }, 403));
    fireEvent.click(screen.getByRole("button", { name: "刷新指标" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前权限不足");
    expect(screen.queryByText("66.7%（2/3 个已决定候选）")).not.toBeInTheDocument();
  });
  it("does not restore a delayed success after a newer poll denies access", async () => {
    let completeFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      completeFirst = resolve;
    });
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(response({ error: { message: "当前权限不足" } }, 403));
    const timers = vi.spyOn(globalThis, "setInterval");
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryMetrics contactId="contact-1" />);
    const poll = timers.mock.calls.find(([, delay]) => delay === 15000)?.[0];
    expect(typeof poll).toBe("function");
    await act(async () => {
      if (typeof poll === "function") poll();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("当前权限不足");
    await act(async () => {
      completeFirst(response({ data: metrics }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("当前权限不足");
    expect(screen.queryByText("66.7%（2/3 个已决定候选）")).not.toBeInTheDocument();
  });
});
