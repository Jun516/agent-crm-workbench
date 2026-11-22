import { z } from "zod";

export const memoryTypes = [
  "constraint",
  "commercial_preference",
  "communication_preference",
  "temporary_request",
  "relationship_context",
] as const;

/** L0 business facts and L4 policies deliberately have no customer-memory type. */
export const memoryPolicyFields = {
  memory_type: z.enum(memoryTypes).optional(),
  attribute_key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_.-]*$/)
    .optional(),
  attribute_value: z.string().trim().min(1).max(300).optional(),
  retention_policy: z.enum(["durable", "ephemeral"]).optional(),
  ttl_expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  review_due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  locked: z.boolean().optional(),
  supersedes: z.string().uuid().nullable().optional(),
};
export const memoryPolicyInput = z.object(memoryPolicyFields).strict();
export type MemoryPolicyInput = z.infer<typeof memoryPolicyInput>;
export function pickMemoryPolicy(input: Record<string, unknown>): MemoryPolicyInput {
  return memoryPolicyInput.parse(
    Object.fromEntries(Object.keys(memoryPolicyFields).map((key) => [key, input[key]])),
  );
}
export type MemoryType = (typeof memoryTypes)[number];
export interface MemoryPolicy {
  memory_type: MemoryType;
  attribute_key: string | null;
  attribute_value: string | null;
  risk_level: "medium" | "high";
  retention_policy: "durable" | "ephemeral";
  ttl_expires_at: string | null;
  review_due_at: string | null;
  locked: boolean;
  supersedes: string | null;
}

export function resolveMemoryPolicy(input: MemoryPolicyInput, now = Date.now()): MemoryPolicy {
  const parsed = memoryPolicyInput.parse(input);
  const type = parsed.memory_type ?? "relationship_context";
  const retention =
    parsed.retention_policy ?? (type === "temporary_request" ? "ephemeral" : "durable");
  if (type === "temporary_request" && retention !== "ephemeral")
    throw new Error("memory_temporary_requires_expiry");
  if (
    retention === "ephemeral" &&
    (!parsed.ttl_expires_at || Date.parse(parsed.ttl_expires_at) <= now)
  )
    throw new Error("memory_expiry_required");
  if (retention === "durable" && parsed.ttl_expires_at)
    throw new Error("memory_durable_has_expiry");
  if (parsed.locked && retention !== "durable") throw new Error("memory_lock_requires_durable");
  if (Boolean(parsed.attribute_key) !== Boolean(parsed.attribute_value))
    throw new Error("memory_attribute_pair_required");
  // L0 table namespaces and unqualified projected fields are reserved. Preferences
  // use their own dimensions, e.g. payment.method rather than orders.payment_method.
  if (
    parsed.attribute_key &&
    (/^(orders?|contracts?|crm_leads|leads?|stages?|amount|owner)([_.-]|$)/.test(
      parsed.attribute_key,
    ) ||
      /^(value_cents|total_cents|status|currency|payment_method)$/.test(parsed.attribute_key))
  )
    throw new Error("memory_business_fact_forbidden");
  return {
    memory_type: type,
    attribute_key: parsed.attribute_key ?? null,
    attribute_value: parsed.attribute_value ?? null,
    risk_level: type === "communication_preference" ? "medium" : "high",
    retention_policy: retention,
    ttl_expires_at: parsed.ttl_expires_at ? new Date(parsed.ttl_expires_at).toISOString() : null,
    review_due_at: parsed.review_due_at ? new Date(parsed.review_due_at).toISOString() : null,
    locked: parsed.locked ?? false,
    supersedes: parsed.supersedes ?? null,
  };
}

export interface SelectableMemory {
  id: string;
  category: string;
  body: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  memory_type?: MemoryType;
  attribute_key?: string | null;
  attribute_value?: string | null;
  risk_level?: "medium" | "high";
  retention_policy?: "durable" | "ephemeral";
  ttl_expires_at?: string | null;
  locked?: boolean;
  needs_review?: boolean;
  review_due_at?: string | null;
  review_reason?: string | null;
  confirmed_by?: string | null;
  confirmed_at?: string;
  policy_revision?: number;
  supersedes?: string | null;
  evidence_conversation_id?: string | null;
}
export const MEMORY_READ_LIMIT = 50;
export const LOCKED_MEMORY_LIMIT = 32;

export function memoryIsValid(row: SelectableMemory, now = Date.now()) {
  if (row.deleted_at) return false;
  if (row.retention_policy === "ephemeral")
    return Boolean(row.ttl_expires_at && Date.parse(row.ttl_expires_at) > now);
  return !row.ttl_expires_at || Date.parse(row.ttl_expires_at) > now;
}
export function memoryNeedsReview(row: SelectableMemory, now = Date.now()) {
  return Boolean(row.needs_review || (row.review_due_at && Date.parse(row.review_due_at) <= now));
}

/** Shared by the SQL candidate window and final ranking, including unspaced CJK tasks. */
export function memoryTaskTerms(task: string) {
  const text = task.slice(0, 2000).toLocaleLowerCase();
  const terms = [...new Set(text.match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 128);
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length && terms.length < 128; i++) {
      const pair = chars[i]! + chars[i + 1]!;
      if (!terms.includes(pair)) terms.push(pair);
    }
  }
  return terms;
}

/** Only SQL L1 rows enter here. Caller reads locked rows independently of search/top-K. */
export function selectCustomerMemories(
  rows: SelectableMemory[],
  remoteIds: string[],
  task: string,
  now = Date.now(),
) {
  const valid = [
    ...new Map(rows.filter((row) => memoryIsValid(row, now)).map((row) => [row.id, row])).values(),
  ];
  const locked = valid.filter((row) => row.locked);
  if (locked.length > LOCKED_MEMORY_LIMIT)
    throw new Error("customer_memory_locked_budget_exceeded");
  const terms = memoryTaskTerms(task);
  const relevance = (row: SelectableMemory) => {
    const text =
      `${row.memory_type ?? ""} ${row.attribute_key ?? ""} ${row.body}`.toLocaleLowerCase();
    return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
  };
  const compare = (a: SelectableMemory, b: SelectableMemory) => {
    const review = Number(memoryNeedsReview(a, now)) - Number(memoryNeedsReview(b, now));
    const semantic = relevance(b) - relevance(a);
    const rank = (id: string) => {
      const i = remoteIds.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return (
      review ||
      semantic ||
      rank(a.id) - rank(b.id) ||
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      a.id.localeCompare(b.id)
    );
  };
  locked.sort(
    (a, b) =>
      Number(b.memory_type === "constraint") - Number(a.memory_type === "constraint") ||
      compare(a, b),
  );
  const others = valid.filter((row) => !row.locked).sort(compare);
  // Locks do not compete for ordinary preference slots. A truncated read is explicit.
  const selected = [...locked, ...others.slice(0, Math.max(0, 10 - locked.length))];
  return { selected, truncated: selected.length < valid.length };
}

export function projectCustomerMemory(row: SelectableMemory, now = Date.now()) {
  const needsReview = memoryNeedsReview(row, now);
  return {
    id: row.id,
    category: row.category,
    body: row.body,
    revision: row.content_hash,
    confirmed: true as const,
    created_at: row.created_at,
    updated_at: row.updated_at,
    authority: "customer_context_only" as const,
    memory_type: row.memory_type ?? "relationship_context",
    retention_policy: row.retention_policy ?? "durable",
    ttl_expires_at: row.ttl_expires_at ?? null,
    risk_level: row.risk_level ?? "high",
    locked: row.locked ?? false,
    needs_review: needsReview,
    review_warning: needsReview ? "可能已过时，需人工判断；CRM 业务字段优先。" : null,
    review_note: row.review_reason?.startsWith("human_review:")
      ? row.review_reason.slice(13)
      : null,
    confirmed_by: row.confirmed_by ?? null,
    confirmed_at: row.confirmed_at ?? row.created_at,
    policy_revision: row.policy_revision ?? 1,
    evidence_conversation_id: row.evidence_conversation_id ?? null,
  };
}
