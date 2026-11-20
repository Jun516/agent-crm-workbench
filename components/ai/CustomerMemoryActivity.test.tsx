import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CustomerMemoryActivity } from "./CustomerMemoryActivity";
const row = {
  id: "job",
  revision: "a".repeat(64),
  source_kind: "conversation_close",
  kind: "customer_memory_extract",
  state: "unavailable",
  created_at: "2026-11-12T12:00:00Z",
  run_after: "2026-11-12T12:00:00Z",
  retryable: true,
  candidates: null,
  conflicts: null,
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("visible memory background work", () => {
  it("explains missing configuration and reuses an uncertain retry key without secure-context randomUUID", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    let sends = 0;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          sends++;
          if (sends === 1) throw new Error("结果尚未确认");
          return response({ data: { status: "pending" } });
        }
        return response({
          data: [sends > 1 ? { ...row, state: "queued", retryable: false } : row],
          meta: { can_retry: true },
        });
      }),
    );
    render(<CustomerMemoryActivity contactId="contact" />);
    await screen.findByText(/自动整理需要处理/);
    expect(screen.getByRole("link", { name: "模型设置" })).toHaveAttribute(
      "href",
      "/app/ai/providers",
    );
    fireEvent.click(screen.getByRole("button", { name: "查看需要处理的整理记录" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试整理" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("结果尚未确认");
    fireEvent.click(screen.getByRole("button", { name: "重试整理" }));
    await screen.findByText(/等待后台整理/);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.request_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bodies[0]!.request_key).toBe(bodies[1]!.request_key);
    expect(bodies[0]).toMatchObject({
      contact_id: "contact",
      job_id: "job",
      revision: row.revision,
    });
  });
  it.each([
    { canRetry: false, readOnly: false },
    { canRetry: true, readOnly: true },
  ])("does not offer a write outside current UI capabilities: %o", async (props) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ data: [row], meta: { can_retry: props.canRetry } })),
    );
    render(<CustomerMemoryActivity contactId="contact" readOnly={props.readOnly} />);
    await screen.findByText(/自动整理需要处理/);
    fireEvent.click(screen.getByRole("button", { name: "查看需要处理的整理记录" }));
    expect(screen.queryByRole("button", { name: "重试整理" })).not.toBeInTheDocument();
  });
  it("walks an empty partial page without calling it absence", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: [], meta: { cursor: "opaque", coverage: "partial" } }),
      )
      .mockResolvedValueOnce(response({ data: [row], meta: {} }));
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryActivity contactId="contact" />);
    await screen.findByText(/本批没有可展示记录/);
    fireEvent.click(screen.getByRole("button", { name: "继续加载整理记录" }));
    await screen.findByText(/自动整理需要处理/);
    expect(fetcher.mock.calls[1]![0]).toContain("cursor=opaque");
  });
  it("updates retry authority after ownership changes without relying on cached parent capabilities", async () => {
    let allowed = true;
    const timers = vi.spyOn(globalThis, "setInterval");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ data: [row], meta: { can_retry: allowed } })),
    );
    render(<CustomerMemoryActivity contactId="contact" />);
    await screen.findByText(/自动整理需要处理/);
    fireEvent.click(screen.getByRole("button", { name: "查看需要处理的整理记录" }));
    expect(screen.getByRole("button", { name: "重试整理" })).toBeVisible();
    const poll = timers.mock.calls.find(([, ms]) => ms === 15000)?.[0];
    allowed = false;
    await act(async () => {
      if (typeof poll === "function") poll();
    });
    expect(screen.queryByRole("button", { name: "重试整理" })).not.toBeInTheDocument();
    allowed = true;
    await act(async () => {
      if (typeof poll === "function") poll();
    });
    expect(screen.getByRole("button", { name: "重试整理" })).toBeVisible();
  });
  it("removes prior status after revoked access and ignores a late older success", async () => {
    let complete!: (r: Response) => void;
    const delayed = new Promise<Response>((r) => {
      complete = r;
    });
    const timers = vi.spyOn(globalThis, "setInterval");
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(delayed)
      .mockResolvedValue(response({ error: { message: "权限已撤销" } }, 403));
    vi.stubGlobal("fetch", fetcher);
    render(<CustomerMemoryActivity contactId="contact" />);
    const poll = timers.mock.calls.find(([, ms]) => ms === 15000)?.[0];
    await act(async () => {
      if (typeof poll === "function") poll();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("权限已撤销");
    await act(async () => {
      complete(response({ data: [row], meta: {} }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("权限已撤销");
    expect(screen.queryByText(/自动整理需要处理/)).not.toBeInTheDocument();
  });
});
