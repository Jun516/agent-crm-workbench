import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomerMemoryPanel } from "./CustomerMemoryPanel";
vi.mock("./CustomerMemoryMetrics", () => ({ CustomerMemoryMetrics: () => null }));
vi.mock("./CustomerMemoryActivity", () => ({ CustomerMemoryActivity: () => null }));

const contactId = "a0000000-0000-4000-8000-000000000001";
const memory = {
  id: "memory-active",
  category: "preference",
  memory_type: "communication_preference",
  risk_level: "medium",
  body: "Prefers email",
  sync_state: "synced",
  write_outcome: "confirmed",
  deleted_at: null,
  remote_deleted_at: null,
  retention_policy: "durable",
  locked: true,
  needs_review: false,
  confirmed_at: "2026-11-12T00:00:00Z",
  policy_revision: 7,
  evidence_conversation_id: "conversation-proof",
};
function mockMemory(canConfirm = true, canArbitrate = true) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      const data = init?.method
        ? {}
        : String(url).includes("/candidates")
          ? []
          : [
              memory,
              {
                ...memory,
                id: "memory-deleted",
                body: "Deleted private fact",
                deleted_at: "2026-11-01T00:00:00Z",
                write_outcome: "unknown",
              },
            ];
      return new Response(
        JSON.stringify({
          data,
          meta: { can_confirm: canConfirm, can_arbitrate: canArbitrate, conflicts: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
describe("customer memory workflow", () => {
  it("keeps the confirmed fact and lock visible, folds operations and preserves cleanup controls inside disclosure", async () => {
    const calls = mockMemory();
    render(<CustomerMemoryPanel contactId={contactId} />);
    await screen.findByText("Prefers email");
    expect(screen.getByText("已锁定")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看证据会话" })).toHaveAttribute(
      "href",
      "/app/inbox?id=conversation-proof",
    );
    expect(screen.queryByText("Deleted private fact")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步与清理状态（运维）" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText(/外部清理待验证/).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "停用此记忆" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "同步与清理状态（运维）" }));
    expect(screen.getByText(/外部清理待验证/)).toBeVisible();
    expect(screen.getByRole("button", { name: "核对结果，不重复写入" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已在 Mem0 服务确认先前请求已结束" }));
    fireEvent.click(screen.getByRole("button", { name: "核对结果，不重复写入" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body))).toEqual({
      id: "memory-deleted",
      remote_request_settled: true,
    });
  });
  it("sends the displayed policy revision with an explicit unlock", async () => {
    const calls = mockMemory();
    render(<CustomerMemoryPanel contactId={contactId} />);
    await screen.findByText("Prefers email");
    fireEvent.click(screen.getByRole("button", { name: "显式解锁" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/lifecycle"))).toBe(true));
    expect(
      JSON.parse(String(calls.find((c) => c.url.endsWith("/lifecycle"))!.init!.body)),
    ).toMatchObject({
      action: "set_lock",
      locked: false,
      expected_revision: 7,
      contact_id: contactId,
      memory_id: "memory-active",
    });
  });
  it("offers colleagues proposals, without confirmation or lifecycle mutations", async () => {
    const calls = mockMemory(false, false);
    render(<CustomerMemoryPanel contactId={contactId} />);
    await screen.findByText("Prefers email");
    expect(screen.queryByRole("button", { name: "确认并保存" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显式解锁" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "记忆内容" }), {
      target: { value: "Use written summaries" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提出候选" }));
    await screen.findByText("已提交候选，等待客户负责人确认。");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/api/v1/ai/customer-memory/candidates");
    expect(JSON.parse(String(post.init!.body))).not.toHaveProperty("confirmed");
  });
  it("allows read-only inspection without exposing mutation controls", async () => {
    mockMemory();
    render(<CustomerMemoryPanel contactId={contactId} readOnly />);
    await screen.findByText("Prefers email");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并保存" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同步与清理状态（运维）" }));
    expect(screen.getByText(/外部清理待验证/)).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
