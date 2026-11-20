import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { readableMemoryConversations } from "@/lib/ai/customer-memory/source-access";
import { loadMemoryCandidatePage, candidatePosition } from "@/lib/ai/customer-memory/queue";
import { encodeMemoryCursor, decodeMemoryCursor } from "@/lib/ai/customer-memory/cursor";
import { env } from "@/lib/env";
import {
  proposeMemoryInput,
  proposeCustomerMemory,
  decideMemoryInput,
  decideCustomerMemory,
} from "@/lib/ai/customer-memory/candidates";

async function readableConversations(org: string, ids: string[]) {
  return readableMemoryConversations(org, ids);
}
async function canReadCandidateSources(org: string, id: string) {
  const rows = await getRequestPool().query<{
    source_kind: string;
    conversation_id: string | null;
  }>(
    `select c.source_kind,e.conversation_id from ai_customer_memory_candidates c
     left join ai_customer_memory_evidence e on e.organization_id=c.organization_id and e.contact_id=c.contact_id and e.candidate_id=c.id
     where c.organization_id=$1 and c.id=$2 and c.deleted_at is null`,
    [org, id],
  );
  if (!rows.rows[0]) return false;
  if (rows.rows[0].source_kind === "explicit") return true;
  const ids = rows.rows.flatMap((row) => (row.conversation_id ? [row.conversation_id] : []));
  const readable = await readableConversations(org, ids);
  return ids.length > 0 && ids.every((id) => readable.has(id));
}

function memoryFailure(error: unknown, requestId: string) {
  const code = error instanceof Error ? error.message : "unknown";
  if (
    [
      "customer_memory_forbidden",
      "customer_memory_owner_required",
      "customer_memory_manager_required",
    ].includes(code)
  )
    return fail("forbidden", "仅客户负责人或经理可确认，冲突由经理仲裁。同事可以提出候选。", 403, {
      requestId,
    });
  if (code.endsWith("_unavailable"))
    return fail("not_found", "客户、候选或来源证据已不可用，请刷新。", 404, { requestId });
  if (error instanceof z.ZodError || code.startsWith("memory_"))
    return fail(
      "invalid_request",
      "请检查记忆类型、有效期和证据。临时诉求必须设置到期时间。",
      400,
      { requestId },
    );
  if (code.startsWith("customer_memory_"))
    return fail("conflict", "候选已变化，或需要先处理冲突/解锁。请刷新后查看当前状态。", 409, {
      requestId,
    });
  return fail(
    "internal_error",
    "操作结果暂未确认，请刷新候选状态；提议重试应沿用原 request_key。",
    503,
    { requestId },
  );
}
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({
      contact_id: z.string().uuid(),
      status: z.enum(["pending", "all"]).default("pending"),
      cursor: z.string().max(2048).optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return fail("invalid_request", "需要有效联系人。", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  try {
    const pool = getRequestPool();
    const contact = await pool.query(
      "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
      [auth.org.orgId, input.data.contact_id],
    );
    if (!contact.rows[0]) return fail("not_found", "客户不可用。", 404, { requestId });
    const binding = {
      org: auth.org.orgId,
      actor: auth.user.id,
      contact: input.data.contact_id,
      resource: "candidates",
      filter: input.data.status,
    };
    const after = input.data.cursor
      ? candidatePosition.parse(decodeMemoryCursor(input.data.cursor, binding, env.INTERNAL_SECRET))
      : null;
    const page = await loadMemoryCandidatePage(
      pool,
      auth.org.orgId,
      input.data.contact_id,
      input.data.status,
      after,
      (ids) => readableConversations(auth.org.orgId, ids),
    );
    // Revalidate after the evidence read; privacy changes must not race a stale body into a response.
    const current = await pool.query(
      "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
      [auth.org.orgId, input.data.contact_id],
    );
    if (!current.rows[0]) return fail("not_found", "客户不可用。", 404, { requestId });
    return ok(page.rows, {
      requestId,
      meta: {
        has_more: page.has_more,
        cursor: page.cursor ? encodeMemoryCursor(page.cursor, binding, env.INTERNAL_SECRET) : null,
        coverage: page.scan_partial ? "partial" : "complete",
      },
    });
  } catch (error) {
    return memoryFailure(error, requestId);
  }
}
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const input = proposeMemoryInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("invalid_request", "请提供记忆建议及有效的来源摘录。", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    if (input.data.evidence.length) {
      const client = await createClient();
      const ids = [...new Set(input.data.evidence.map((e) => e.message_id))];
      const visible = await client
        .from("messages")
        .select("id")
        .eq("organization_id", auth.org.orgId)
        .eq("contact_id", input.data.contact_id)
        .in("id", ids);
      if (visible.error || visible.data.length !== ids.length)
        return fail("not_found", "来源证据不可用。", 404, { requestId });
    }
    const data = await proposeCustomerMemory(getRequestPool(), auth.org.orgId, input.data, {
      kind: "explicit",
      actor: auth.user.id,
    });
    if (!["suppressed", "already_confirmed"].includes(data.status))
      await audit({
        action: "ai.customer_memory_proposed",
        actorUserId: auth.user.id,
        organizationId: auth.org.orgId,
        resourceType: "ai_customer_memory_candidates",
        resourceId: data.id,
        requestId,
      });
    return ok(data, { requestId });
  } catch (error) {
    return memoryFailure(error, requestId);
  }
}
export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = decideMemoryInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "invalid_request",
      "请提供当前候选版本；驳回时需要原因和暂停同类建议的截止时间。",
      400,
      { requestId },
    );
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    if (!(await canReadCandidateSources(auth.org.orgId, input.data.id)))
      return fail("not_found", "候选来源不可用或不在你的可见范围内。", 404, { requestId });
    const data = await decideCustomerMemory(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      input.data,
    );
    await audit({
      action: "ai.customer_memory_candidate_decided",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memory_candidates",
      resourceId: data.id,
      requestId,
      metadata: { decision: input.data.action },
    });
    return ok(data, { requestId });
  } catch (error) {
    return memoryFailure(error, requestId);
  }
}
