import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { readableMemoryConversations } from "@/lib/ai/customer-memory/source-access";
import { env } from "@/lib/env";
import { z } from "zod";
import { encodeMemoryCursor, decodeMemoryCursor } from "@/lib/ai/customer-memory/cursor";
import {
  memoryUsageQuery,
  memoryCorrectionInput,
  resolveMemoryUsageTarget,
  loadCustomerMemoryUsage,
  correctCustomerMemoryUsage,
} from "@/lib/ai/customer-memory/usage";
function failure(error: unknown, requestId: string) {
  const code = error instanceof Error ? error.message : "unknown";
  if (code.includes("_forbidden") || code.endsWith("_required"))
    return fail("forbidden", "此使用记录不在你的当前权限范围内。", 403, { requestId });
  if (code.endsWith("_unavailable"))
    return fail("not_found", "客户或使用记录已不可用，请刷新。", 404, { requestId });
  if (error instanceof z.ZodError || code.startsWith("memory_"))
    return fail("invalid_request", "分页位置无效，请刷新使用记录。", 400, { requestId });
  return fail("internal_error", "暂时无法核对记忆使用记录，请重试。", 503, { requestId });
}
async function assertConversation(org: string, id: string | null) {
  if (id && !(await readableMemoryConversations(org, [id])).has(id))
    throw new Error("customer_memory_conversation_unavailable");
}
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = memoryUsageQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success)
    return fail("invalid_request", "请选择报告、草稿或会话。", 400, { requestId });
  const auth = await requireRole(input.data.context === "workbench" ? "manager" : "agent", {
    requestId,
    resource: "ai_workbench",
  });
  if (!auth.ok) return auth.response;
  try {
    const pool = getRequestPool(),
      target = await resolveMemoryUsageTarget(pool, auth.org.orgId, input.data);
    await assertConversation(auth.org.orgId, target.conversationId);
    const binding = {
      org: auth.org.orgId,
      actor: auth.user.id,
      contact: target.contactId,
      resource: "usage",
      filter: `${input.data.context}:${input.data.id}`,
    };
    const cursor = input.data.cursor
      ? z
          .object({ cursor: z.string().max(500) })
          .strict()
          .parse(decodeMemoryCursor(input.data.cursor, binding, env.INTERNAL_SECRET)).cursor
      : undefined;
    const data = await loadCustomerMemoryUsage(pool, auth.org.orgId, target, cursor);
    const sources = await readableMemoryConversations(
      auth.org.orgId,
      data.usage.flatMap((row) =>
        row.evidence_conversation_id ? [String(row.evidence_conversation_id)] : [],
      ),
    );
    const rows = data.usage.map((row) => ({
      ...row,
      evidence_conversation_id: sources.has(String(row.evidence_conversation_id))
        ? row.evidence_conversation_id
        : null,
    }));
    await assertConversation(auth.org.orgId, target.conversationId);
    if (
      !(
        await pool.query(
          "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
          [auth.org.orgId, target.contactId],
        )
      ).rows.length
    )
      throw new Error("customer_memory_contact_unavailable");
    return ok(
      { recalls: data.recalls, usage: rows },
      {
        requestId,
        meta: {
          ...data.meta,
          cursor: data.meta.cursor
            ? encodeMemoryCursor({ cursor: data.meta.cursor }, binding, env.INTERNAL_SECRET)
            : null,
        },
      },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = memoryCorrectionInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("invalid_request", "请提供使用记录 ID 和纠正原因。", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const pool = getRequestPool(),
      target = await resolveMemoryUsageTarget(pool, auth.org.orgId, input.data);
    if (target.managerOnly && !roleAtLeast(auth.org.role, "manager"))
      return fail("forbidden", "报告使用记录需要经理权限。", 403, { requestId });
    await assertConversation(auth.org.orgId, target.conversationId);
    const result = await correctCustomerMemoryUsage(
      pool,
      auth.org.orgId,
      auth.user.id,
      input.data,
      (id) => assertConversation(auth.org.orgId, id),
    );
    return ok(result, { requestId });
  } catch (error) {
    return failure(error, requestId);
  }
}
