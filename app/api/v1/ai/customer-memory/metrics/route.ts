import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { loadCustomerMemoryMetrics } from "@/lib/ai/customer-memory/metrics";
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const input = z
    .object({ contact_id: z.uuid() })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return fail("invalid_request", "请选择有效客户。", 400, { requestId });
  try {
    return ok(
      await loadCustomerMemoryMetrics(
        getRequestPool(),
        auth.org.orgId,
        auth.user.id,
        input.data.contact_id,
      ),
      { requestId },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (["customer_memory_forbidden", "customer_memory_manager_required"].includes(code))
      return fail("forbidden", "记忆治理指标需要当前经理权限。", 403, { requestId });
    if (code === "customer_memory_contact_unavailable")
      return fail("not_found", "客户不可用。", 404, { requestId });
    return fail("internal_error", "暂时无法统计记忆治理指标，请重试。", 503, { requestId });
  }
}
