import { describe, expect, it } from "vitest";
import {
  memoryIsValid,
  memoryTaskTerms,
  projectCustomerMemory,
  resolveMemoryPolicy,
  selectCustomerMemories,
  type SelectableMemory,
} from "./policy";
const now = Date.parse("2026-11-12T00:00:00Z");
const row = (id: string, extra: Partial<SelectableMemory> = {}): SelectableMemory => ({
  id,
  category: "preference",
  body: "prefers email",
  content_hash: "hash",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...extra,
});
describe("customer-memory trust and freshness policy", () => {
  it("bounds shared task terms while preserving CJK relevance and literal punctuation handling", () => {
    expect(memoryTaskTerms("请用电子邮件拟一封跟进消息")).toEqual(
      expect.arrayContaining(["电子", "邮件"]),
    );
    expect(memoryTaskTerms("Email EMAIL fax% ' OR 1=1")).toEqual(["email", "fax", "or"]);
    expect(
      memoryTaskTerms(Array.from({ length: 1000 }, (_, n) => `term${n}`).join(" ")).length,
    ).toBeLessThanOrEqual(128);
  });
  it("requires expiration for temporary requests and forbids a competing business authority", () => {
    expect(() => resolveMemoryPolicy({ memory_type: "temporary_request" }, now)).toThrow(
      "expiry_required",
    );
    expect(() =>
      resolveMemoryPolicy({ memory_type: "temporary_request", retention_policy: "durable" }, now),
    ).toThrow("temporary_requires_expiry");
    expect(() =>
      resolveMemoryPolicy(
        {
          memory_type: "commercial_preference",
          attribute_key: "amount_cents",
          attribute_value: "100",
        },
        now,
      ),
    ).toThrow("business_fact_forbidden");
    expect(resolveMemoryPolicy({ memory_type: "communication_preference" }, now)).toMatchObject({
      risk_level: "medium",
      retention_policy: "durable",
      locked: false,
    });
  });
  it("rejects canonical L0 namespaces and bare business fields without blocking customer preference dimensions", () => {
    const businessKeys = [
      "orders.total_cents",
      "contracts.payment_terms",
      "crm_leads.status",
      "lead.stage_id",
      "leads.owner_user_id",
      "order_total",
      "contract.payment_method",
      "stage_id",
      "owner_user_id",
      "amount_cents",
      "value_cents",
      "total_cents",
      "status",
      "currency",
      "payment_method",
    ];
    for (const key of businessKeys) {
      expect(
        () => resolveMemoryPolicy({ attribute_key: key, attribute_value: "copied L0" }, now),
        key,
      ).toThrow("memory_business_fact_forbidden");
    }
    for (const key of [
      "commercial.price_sensitivity",
      "payment.method",
      "communication.channel",
      "relationship.role",
      "leadership.style",
    ]) {
      expect(
        resolveMemoryPolicy({ attribute_key: key, attribute_value: "customer preference" }, now)
          .attribute_key,
      ).toBe(key);
    }
  });
  it("never injects expired, tombstoned, or malformed ephemeral facts, even locked/remote-ranked ones", () => {
    const expired = row("expired", {
      retention_policy: "ephemeral",
      ttl_expires_at: "2026-11-11T00:00:00Z",
      locked: true,
    });
    const malformed = row("malformed", { retention_policy: "ephemeral" });
    const deleted = row("deleted", { deleted_at: "2026-11-10T00:00:00Z" });
    expect(memoryIsValid(expired, now)).toBe(false);
    expect(
      selectCustomerMemories(
        [expired, malformed, deleted, row("valid")],
        ["expired"],
        "email",
        now,
      ).selected.map((m) => m.id),
    ).toEqual(["valid"]);
  });
  it("keeps a locked constraint on a search miss and beyond ordinary top-K", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`recent-${i}`));
    rows.push(
      row("no-evening-call", {
        locked: true,
        memory_type: "constraint",
        body: "never call after 18:00",
        created_at: "2020-01-01T00:00:00Z",
      }),
    );
    const selected = selectCustomerMemories(rows, ["recent-0"], "email", now);
    expect(selected.selected[0]?.id).toBe("no-evening-call");
    expect(selected.selected).toHaveLength(10);
    expect(selected.truncated).toBe(true);
  });
  it("prioritizes task relevance before remote rank and lowers possibly outdated preferences", () => {
    const result = selectCustomerMemories(
      [
        row("remote", { body: "likes detailed product comparisons" }),
        row("relevant", { body: "prefers email for follow-up" }),
        row("stale", { body: "email only", review_due_at: "2026-11-11T00:00:00Z" }),
      ],
      ["remote", "stale"],
      "email follow-up",
      now,
    );
    expect(result.selected.map((m) => m.id)).toEqual(["relevant", "remote", "stale"]);
    expect(projectCustomerMemory(result.selected[2]!, now)).toMatchObject({
      needs_review: true,
      confirmed: true,
      review_warning: expect.stringContaining("CRM"),
    });
  });
  it("never silently drops locked constraints when a safety budget is exceeded", () => {
    expect(() =>
      selectCustomerMemories(
        Array.from({ length: 33 }, (_, i) => row(String(i), { locked: true })),
        [],
        "",
        now,
      ),
    ).toThrow("locked_budget_exceeded");
  });
  it("exposes confirmation provenance and policy revision in each injected fact", () => {
    expect(
      projectCustomerMemory(
        row("m1", {
          confirmed_by: "owner",
          confirmed_at: "2026-11-02T00:00:00Z",
          policy_revision: 4,
          locked: true,
          memory_type: "constraint",
        }),
        now,
      ),
    ).toMatchObject({
      id: "m1",
      risk_level: "high",
      locked: true,
      confirmed_by: "owner",
      confirmed_at: "2026-11-02T00:00:00Z",
      policy_revision: 4,
    });
  });
  it("matches task-relevant Chinese preferences without whitespace token boundaries", () => {
    const result = selectCustomerMemories(
      [row("unrelated", { body: "通常晚上沟通" }), row("payment", { body: "偏好分期付款" })],
      ["unrelated"],
      "比较付款方式",
      now,
    );
    expect(result.selected[0]?.id).toBe("payment");
  });
});
