import { requireRole } from "@/lib/auth/require-role";
import { sessionAal } from "@/lib/auth/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { executeWithIdentity } from "./read-plan-internal";

/** Cookie-session entry point; identity, role and organization are never plan parameters. */
export async function executeReadPlan(plan: unknown, signal?: AbortSignal) {
  const auth = await requireRole("viewer", { resource: "ontology" });
  if (!auth.ok || auth.user.support) throw new Error("ontology_forbidden");
  const aal = await sessionAal();
  if (!aal) throw new Error("ontology_forbidden");
  let pool;
  try {
    pool = getRequestPool();
  } catch {
    throw new Error("ontology_read_unavailable");
  }
  return executeWithIdentity(
    pool,
    plan,
    { userId: auth.user.id, organizationId: auth.org.orgId, aal },
    signal,
  );
}
