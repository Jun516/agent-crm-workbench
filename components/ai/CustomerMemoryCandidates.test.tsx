import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomerMemoryCandidates } from "./CustomerMemoryCandidates";
vi.mock("./CustomerMemoryActivity", () => ({ CustomerMemoryActivity: () => null }));
import type { MemoryCandidateView } from "@/lib/ai/customer-memory/view";
const contact = "a0000000-0000-4000-8000-000000000001";
const candidate: MemoryCandidateView = {
  id: "candidate",
  body: "Email preferred",
  category: "communication_context",
  attribute_key: null,
  attribute_value: null,
  memory_type: "communication_preference",
  risk_level: "medium",
  source_kind: "workbench_complete",
  model_confidence: 0.9,
  created_at: "2026-11-12T00:00:00Z",
  revision_token: "current-sql-microsecond-token",
  ttl_expires_at: null,
  evidence: [
    {
      id: "proof",
      conversation_id: "visible-conversation",
      message_id: "message",
      excerpt: "Please use email.",
      observed_at: "2026-11-12T00:00:00Z",
    },
  ],
  conflicts: [],
};
const caps = { can_confirm: true, can_arbitrate: false };
function mockRows(row = candidate) {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method) writes.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ data: init?.method ? {} : writes.length ? [] : [row] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return writes;
}
afterEach(() => vi.unstubAllGlobals());
describe("report-footer confirmation cards", () => {
  it("lets a salesperson continue past a partial empty permission-filtered page without claiming absence", async () => {
    let next = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        next = String(url).includes("cursor=opaque");
        return new Response(
          JSON.stringify({
            data: next ? [candidate] : [],
            meta: {
              has_more: !next,
              cursor: next ? null : "opaque",
              coverage: next ? "complete" : "partial",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    render(<CustomerMemoryCandidates contactId={contact} capabilities={caps} />);
    await screen.findByText(/权限筛选尚未检查完/);
    expect(screen.queryByText(/暂未发现待确认建议/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多建议" }));
    await screen.findByText(candidate.body);
    expect(next).toBe(true);
  });
  it("keeps a loaded next page when an older refresh response arrives late", async () => {
    let finishRefresh!: (value: Response) => void;
    let calls = 0;
    const response = (rows: unknown[], more = false) =>
      new Response(
        JSON.stringify({ data: rows, meta: { has_more: more, cursor: more ? "next" : null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 2)
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      return calls === 1
        ? response([candidate], true)
        : response([{ ...candidate, id: "later", body: "Later visible suggestion" }]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryCandidates contactId={contact} capabilities={caps} />);
    await screen.findByText(candidate.body);
    fireEvent.click(screen.getByRole("button", { name: "刷新建议" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "加载更多建议" }));
    await screen.findByText("Later visible suggestion", { selector: "p" });
    await act(async () => finishRefresh(response([candidate], true)));
    expect(screen.getByText("Later visible suggestion", { selector: "p" })).toBeVisible();
  });
  it("shows the exact evidence and confirms a rewritten hypothesis using its current token", async () => {
    const writes = mockRows();
    render(<CustomerMemoryCandidates contactId={contact} runId="run" capabilities={caps} />);
    await screen.findByText("Email preferred");
    expect(screen.getByText("“Please use email.”")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看来源会话" })).toHaveAttribute(
      "href",
      "/app/inbox?id=visible-conversation",
    );
    fireEvent.click(screen.getByRole("button", { name: "改写" }));
    fireEvent.change(screen.getByRole("textbox", { name: "改写记忆内容" }), {
      target: { value: "Prefer email for normal enquiries" },
    });
    fireEvent.click(screen.getByRole("button", { name: "改写后确认" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      id: "candidate",
      action: "confirm",
      revision_token: "current-sql-microsecond-token",
      body: "Prefer email for normal enquiries",
    });
  });
  it("requires a rejection reason and an explicitly chosen cooldown", async () => {
    const writes = mockRows();
    render(<CustomerMemoryCandidates contactId={contact} capabilities={caps} />);
    await screen.findByText("Email preferred");
    fireEvent.click(screen.getByRole("button", { name: "驳回" }));
    expect(screen.getByRole("button", { name: "确认驳回" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "驳回原因" }), {
      target: { value: "One-off request" },
    });
    fireEvent.change(screen.getByLabelText("暂停同类建议至（本地时区）"), {
      target: { value: "2099-01-01T12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认驳回" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      action: "reject",
      reason: "One-off request",
      rejected_until: new Date("2099-01-01T12:00").toISOString(),
    });
  });
  it("prevents ordinary confirmation of a conflict and directs the reviewer to its customer", async () => {
    mockRows({
      ...candidate,
      conflicts: [
        {
          id: "conflict",
          memory_id: "confirmed-fact",
          kind: "l2_l1",
          created_at: "2026-11-12T00:00:00Z",
        },
      ],
    });
    render(<CustomerMemoryCandidates contactId={contact} capabilities={caps} />);
    await screen.findByText("Email preferred");
    expect(screen.getByRole("button", { name: "同意并确认" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "查看并处理已确认记忆" })).toHaveAttribute(
      "href",
      `/app/contacts/${contact}#customer-memory`,
    );
  });
  it("exposes no candidate decisions to read-only support", async () => {
    mockRows();
    render(<CustomerMemoryCandidates contactId={contact} capabilities={caps} readOnly />);
    await screen.findByText("Email preferred");
    expect(screen.queryByRole("button", { name: "同意并确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回" })).not.toBeInTheDocument();
  });
});
