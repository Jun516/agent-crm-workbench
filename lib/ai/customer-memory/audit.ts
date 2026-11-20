import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { AuditAction } from "@/lib/audit/actions";
import { logger } from "@/lib/logger";

export async function recordMemoryAudit(
  db: Queryable,
  org: string,
  contact: string,
  action: AuditAction,
  metadata: Record<string, unknown>,
) {
  try {
    await db.query(
      `insert into api_audit_log(organization_id,action,resource_type,resource_id,metadata)
      values($1,$2,'contacts',$3,$4::jsonb)`,
      [org, action, contact, JSON.stringify(metadata)],
    );
  } catch {
    // The committed decision must survive an audit transport failure, matching audit().
    logger.error("customer_memory_audit_unavailable", { organization_id: org, action });
  }
}
