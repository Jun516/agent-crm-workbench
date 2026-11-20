import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  loadCustomerMemoryActivity,
  retryCustomerMemoryActivity,
  memoryActivityPosition,
  memoryActivityRetry,
} from "@/lib/ai/customer-memory/activity";
import {
  readableMemoryConversations,
  readableMemoryRuns,
} from "@/lib/ai/customer-memory/source-access";
import { encodeMemoryCursor, decodeMemoryCursor } from "@/lib/ai/customer-memory/cursor";
import { env } from "@/lib/env";
const access = (org: string) => ({
  conversations: (ids: string[]) => readableMemoryConversations(org, ids),
  runs: (ids: string[]) => readableMemoryRuns(org, ids),
});
function failure(error: unknown, requestId: string) {
  const code = error instanceof Error ? error.message : "unknown";
  if (["customer_memory_forbidden", "customer_memory_owner_required"].includes(code))
    return fail("forbidden", "仅当前客户负责人或经理可重试整理。", 403, { requestId });
  if (code.endsWith("_unavailable"))
    return fail("not_found", "客户、后台记录或来源当前不可用。", 404, { requestId });
  if (error instanceof z.ZodError || code === "memory_cursor_invalid")
    return fail("invalid_request", "请刷新后台记录后重试。", 400, { requestId });
  if (["customer_memory_job_stale", "customer_memory_job_not_retryable"].includes(code))
    return fail("conflict", "任务已变化或正在执行，请刷新查看当前状态。", 409, { requestId });
  return fail(
    "internal_error",
    "暂时无法确认后台整理状态，请刷新；重试请求应沿用原 request_key。",
    503,
    { requestId },
  );
}
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const parsed = z
    .object({ contact_id: z.uuid(), cursor: z.string().max(2048).optional() })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("invalid_request", "请选择有效客户。", 400, { requestId });
  try {
    const binding = {
      org: auth.org.orgId,
      actor: auth.user.id,
      contact: parsed.data.contact_id,
      resource: "activity",
    };
    const after = parsed.data.cursor
      ? memoryActivityPosition.parse(
          decodeMemoryCursor(parsed.data.cursor, binding, env.INTERNAL_SECRET),
        )
      : null;
    const page = await loadCustomerMemoryActivity(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      parsed.data.contact_id,
      after,
      access(auth.org.orgId),
    );
    return ok(page.rows, {
      requestId,
      meta: {
        has_more: page.has_more,
        cursor: page.cursor ? encodeMemoryCursor(page.cursor, binding, env.INTERNAL_SECRET) : null,
        coverage: page.coverage,
        can_retry: page.can_retry,
      },
    });
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const parsed = memoryActivityRetry.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("invalid_request", "请提供当前后台记录版本和重试标识。", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const data = await retryCustomerMemoryActivity(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      parsed.data,
      access(auth.org.orgId),
    );
    if (!data.deduped)
      await audit({
        action: "ai.customer_memory_job_retried",
        actorUserId: auth.user.id,
        organizationId: auth.org.orgId,
        resourceType: "job_queue",
        resourceId: data.id,
        requestId,
        metadata: { request_key: parsed.data.request_key },
      });
    return ok(data, { requestId });
  } catch (error) {
    return failure(error, requestId);
  }
}
