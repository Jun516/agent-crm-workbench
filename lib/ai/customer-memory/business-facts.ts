import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
export interface BusinessFact {
  kind: "lead" | "order";
  id: string;
  revision: string;
  fields: Record<string, unknown>;
}
const fingerprint = (row: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(row)).digest("hex");

/** Read projections from L0, never copies in ai_customer_memories. */
export async function loadCustomerBusinessFacts(
  db: Queryable,
  org: string,
  contact: string,
  lock = false,
  focusLeadId: string | null = null,
) {
  const leads = await db.query(
    `select id,stage_id,status,value_cents,currency,owner_user_id,updated_at from crm_leads
     where organization_id=$1 and contact_id=$2 order by (id=$3::uuid) desc nulls last,updated_at desc,id limit 51 ${lock ? "for share" : ""}`,
    [org, contact, focusLeadId],
  );
  const orders = await db.query(
    `select id,status,total_cents,currency,payment_method,updated_at from orders
     where organization_id=$1 and contact_id=$2 and not is_anonymized order by updated_at desc,id limit 51 ${lock ? "for share" : ""}`,
    [org, contact],
  );
  const facts: BusinessFact[] = [
    ...leads.rows.slice(0, 50).map((row) => ({
      kind: "lead" as const,
      id: String(row.id),
      revision: fingerprint(row),
      fields: row,
    })),
    ...orders.rows.slice(0, 50).map((row) => ({
      kind: "order" as const,
      id: String(row.id),
      revision: fingerprint(row),
      fields: row,
    })),
  ];
  return {
    authority: "crm_business_tables" as const,
    coverage: leads.rows.length > 50 || orders.rows.length > 50 ? "partial" : "complete",
    facts,
  };
}
