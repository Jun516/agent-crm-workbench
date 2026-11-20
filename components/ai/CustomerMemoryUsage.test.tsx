import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomerMemoryUsage } from "./CustomerMemoryUsage";
const row = {
  id: "usage-1",
  memory_id: "memory-1",
  policy_revision: 4,
  memory_type: "constraint",
  risk_level: "high",
  locked: true,
  needs_review: false,
  confirmed_by: "confirmed-owner",
  confirmed_at: "2026-11-12T00:00:00Z",
  used_at: "2026-11-12T01:00:00Z",
  body: "Never call after 18:00",
  retired: false,
  current_version_changed: false,
  corrected_at: null,
  correction_reason: null,
  evidence_conversation_id: "source-conversation",
};
const recall = {
  id: "recall",
  status: "ok",
  coverage: "partial",
  provider_status: "unavailable",
  returned_count: 1,
  call_outcome: "success",
};
const response = (data: unknown, meta = {}) =>
  new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());
describe("model-read memory receipts", () => {
  it("shows source metadata and sends artifact-scoped correction, then displays persisted feedback", async () => {
    let corrected = false;
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method === "PATCH") {
          writes.push(JSON.parse(init.body));
          corrected = true;
          return response({});
        }
        return response({
          recalls: [recall],
          usage: [
            {
              ...row,
              corrected_at: corrected ? "2026-11-12T02:00:00Z" : null,
              correction_reason: corrected ? "New availability" : null,
            },
          ],
        });
      }),
    );
    render(<CustomerMemoryUsage context="workbench" id="run-1" />);
    await screen.findByText(row.body);
    expect(screen.getByRole("link", { name: "查看证据会话" })).toHaveAttribute(
      "href",
      "/app/inbox?id=source-conversation",
    );
    fireEvent.click(screen.getByText("记忆 ID、版本与确认信息"));
    expect(screen.getByText(/memory-1 · 版本 4/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "纠正这次记忆使用" }));
    fireEvent.change(screen.getByLabelText("记忆使用纠正原因"), {
      target: { value: "New availability" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交纠正并待复核" }));
    await screen.findByText(/已提交纠正：New availability/);
    expect(writes).toEqual([
      { usage_id: "usage-1", reason: "New availability", context: "workbench", id: "run-1" },
    ]);
  });
  it("distinguishes missing receipts from a consumed empty SQL result", async () => {
    const fetcher = vi.fn(async () => response({ recalls: [], usage: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryUsage context="draft" id="draft-1" />);
    await screen.findByText(/尚无可核验的读取回执/);
    fetcher.mockImplementation(async () =>
      response({ recalls: [{ ...recall, returned_count: 0 }], usage: [] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新使用记录" }));
    await screen.findByText(/模型读取了当前 SQL 召回结果/);
    expect(screen.queryByText(/尚无可核验/)).not.toBeInTheDocument();
  });
  it("hides correction controls in support mode and explains retired bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ recalls: [recall], usage: [{ ...row, body: null, retired: true }] }),
      ),
    );
    render(<CustomerMemoryUsage context="draft" id="draft-1" readOnly />);
    await screen.findByText("该记忆已停用，正文不再展示。");
    expect(screen.queryByRole("button", { name: "纠正这次记忆使用" })).not.toBeInTheDocument();
    expect(screen.queryByText(row.body)).not.toBeInTheDocument();
  });
  it("loads subsequent usage pages without dropping earlier receipts", async () => {
    const fetcher = vi.fn(async (url) =>
      String(url).includes("cursor=next")
        ? response({ recalls: [recall], usage: [{ ...row, id: "usage-2", body: "Prefer email" }] })
        : response({ recalls: [recall], usage: [row] }, { cursor: "next", has_more: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryUsage context="workbench" id="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多使用记录" }));
    await screen.findByText("Prefer email");
    expect(screen.getByText(row.body)).toBeVisible();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
