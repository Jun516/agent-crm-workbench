/**
 * A paused Mission must fail the send gate the worker actually calls.
 * The baseline is dump plus appendix, so only the last definition is installed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

function lastFunction(name: string): string {
  const marker = `create or replace function public.${name}`;
  const start = baseline.lastIndexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = baseline.indexOf("$$;", start);
  return baseline.slice(start, end);
}

describe("Mission pause reaches the final customer-send gate", () => {
  it("rejects a paused Mission in the last reply-context definition", () => {
    const body = lastFunction("fn_reply_context_current");
    expect(body).toContain("not m.customer_send_paused");
    expect(body).toContain("m.customer_send_paused_at is null or d.approved_at is null");
    expect(body).toContain("or d.approved_at > m.customer_send_paused_at");
  });

  it("makes the worker delivery policy read that same context gate", () => {
    const body = lastFunction("fn_reply_delivery_policy");
    expect(body).toContain("public.fn_reply_context_current");
    expect(body).toContain("'context_current'");
  });

  it("replays a send command from the same request key without a second effect", () => {
    const body = lastFunction("fn_set_ai_mission_send_policy");
    expect(body).toContain("'result','replayed'");
    expect(body).toContain("v_mission.customer_send_paused");
    expect(body).toContain("v_prior.id");
  });
});
