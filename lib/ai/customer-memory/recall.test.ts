import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfirmedCustomerMemory } from "@/lib/ai/integrations/mem0";
const org = "a0000000-0000-4000-8000-000000000001";
const contact = "a0000000-0000-4000-8000-000000000002";
const row = (id: string, extra = {}) => ({
  id,
  organization_id: org,
  contact_id: contact,
  category: "preference",
  body: "email preferred",
  content_hash: "a".repeat(64),
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  locked: false,
  deleted_at: null,
  ...extra,
});
afterEach(() => vi.unstubAllEnvs());
describe("SQL-backed customer memory selection", () => {
  it("reads old locked constraints separately from the bounded recent window", async () => {
    vi.stubEnv("AI_INTEGRATION_BINDINGS", "");
    const recent = Array.from({ length: 51 }, (_, i) => row(`recent-${i}`));
    const constraint = row("locked-old", {
      body: "Never contact in the evening",
      memory_type: "constraint",
      locked: true,
      confirmed_by: "owner",
      created_at: "2020-01-01T00:00:00Z",
    });
    const query = vi.fn(async (q: { text: string; values: unknown[] }) => {
      expect(q.values.slice(0, 2)).toEqual([org, contact]);
      if (q.text.includes("select id from contacts")) return { rows: [{ id: contact }] };
      if (!q.text.includes("locked=true")) expect(q.values[2]).toEqual(["email"]);
      return { rows: q.text.includes("locked=true") ? [constraint] : recent };
    });
    const recalled = await readConfirmedCustomerMemory(
      { query } as unknown as Pool,
      org,
      contact,
      "email",
    );
    expect(recalled.memories[0]).toMatchObject({
      id: "locked-old",
      locked: true,
      memory_type: "constraint",
      confirmed_by: "owner",
    });
    expect(recalled).toMatchObject({
      status: "local",
      coverage: "partial",
      returnedCount: 10,
      absence_semantics: "not_recalled_does_not_mean_no_preference",
    });
    expect(query.mock.calls.filter(([q]) => q.text.includes("locked=true"))).toHaveLength(2);
  });
  it("rechecks expiration and contact availability before returning facts", async () => {
    vi.stubEnv("AI_INTEGRATION_BINDINGS", "");
    let reads = 0;
    const query = vi.fn(async (q: { text: string }) => {
      if (q.text.includes("select id from contacts")) return { rows: [{ id: contact }] };
      reads++;
      return {
        rows: [
          row("retired", { ttl_expires_at: "2020-01-01T00:00:00Z", retention_policy: "ephemeral" }),
          ...(reads <= 2 ? [row("removed-during-read")] : []),
        ],
      };
    });
    const result = await readConfirmedCustomerMemory({ query } as unknown as Pool, org, contact);
    expect(result.memories).toEqual([]);
    expect(result.coverage).toBe("complete");
    expect(
      query.mock.calls.filter(([q]) => q.text.includes("select id from contacts")),
    ).toHaveLength(3);
  });
});
