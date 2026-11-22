import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { appendWorkbenchEvent } from "./workbench-events";

it("uses one atomic RPC per event and redacts mixed tool payloads", async () => {
  let sequence = 0;
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: ++sequence,
    error: null,
  }));
  const admin = { rpc } as unknown as SupabaseClient;
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      appendWorkbenchEvent(admin, {
        organizationId: "org",
        runId: "run",
        type: "tool_started",
        payload: {
          tool: index % 2 ? "ontology_query" : "crm_list_leads",
          toolCallId: String(index),
          apiKey: "never-record",
        },
      }),
    ),
  );
  expect(results).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  expect(rpc).toHaveBeenCalledTimes(16);
  for (const [name, args] of rpc.mock.calls) {
    expect(name).toBe("fn_append_workbench_event");
    expect(args).toMatchObject({ p_org: "org", p_run: "run", p_type: "tool_started" });
    expect(JSON.stringify(args)).not.toContain("never-record");
  }
});

it("surfaces an RPC failure and permits the next event", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: null, error: { message: "synthetic" } })
    .mockResolvedValueOnce({ data: 1, error: null });
  const admin = { rpc } as unknown as SupabaseClient;
  const input = { organizationId: "org", runId: "run", type: "tool_started" as const };
  await expect(appendWorkbenchEvent(admin, input)).rejects.toThrow("workbench_event_append_failed");
  await expect(appendWorkbenchEvent(admin, input)).resolves.toBe(1);
});
