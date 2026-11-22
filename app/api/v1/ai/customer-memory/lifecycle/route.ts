import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  changeCustomerMemoryLifecycle,
  memoryLifecycleInput,
} from "@/lib/ai/customer-memory/lifecycle";

export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = memoryLifecycleInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("invalid_request", "请检查记忆、版本、复核日期和处理原因。", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const data = await changeCustomerMemoryLifecycle(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      input.data,
    );
    await audit({
      action: "ai.customer_memory_lifecycle_changed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: data.id,
      requestId,
      metadata: {
        action: input.data.action,
        expected_revision: input.data.expected_revision,
        ...("reason" in input.data ? { reason: input.data.reason } : { locked: input.data.locked }),
      },
    });
    return ok(data, { requestId });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (
      [
        "customer_memory_forbidden",
        "customer_memory_owner_required",
        "customer_memory_manager_required",
      ].includes(code)
    )
      return fail("forbidden", "负责人可锁定或复核，冲突需要经理处理。", 403, { requestId });
    if (code.endsWith("_unavailable"))
      return fail("not_found", "记忆或冲突已不可用，请刷新。", 404, { requestId });
    if (code.startsWith("memory_"))
      return fail("invalid_request", "请检查有效期。临时记忆不能锁定，复核日期应在未来。", 400, {
        requestId,
      });
    if (code.startsWith("customer_memory_"))
      return fail(
        "conflict",
        "记忆或业务数据已变化；请刷新，锁定项需先显式解锁，候选冲突请在候选卡片处理。",
        409,
        { requestId },
      );
    return fail("internal_error", "暂时无法处理记忆，请刷新后重试。", 503, { requestId });
  }
}
