import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  assertMemoryAuthority,
  withMemoryContact,
  customerMemoryCapabilities,
} from "@/lib/ai/customer-memory/authority";
import { readableMemoryConversations } from "@/lib/ai/customer-memory/source-access";
import { env } from "@/lib/env";
import { encodeMemoryCursor, decodeMemoryCursor } from "@/lib/ai/customer-memory/cursor";
const pagePosition = z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() }).strict();
import {
  customerMemoryInput,
  saveCustomerMemory,
  deleteCustomerMemory,
  reconcileCustomerMemory,
} from "@/lib/ai/integrations/mem0";

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const input = customerMemoryInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "invalid_request",
      "Confirm a customer preference, fact or communication context. Company/product policy belongs in Wiki.",
      400,
      { requestId },
    );
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const pool = getRequestPool();
    const data = await withMemoryContact(
      pool,
      auth.org.orgId,
      input.data.contact_id,
      async (db) => {
        await assertMemoryAuthority(
          db,
          auth.org.orgId,
          input.data.contact_id,
          auth.user.id,
          "confirm",
        );
        return saveCustomerMemory(pool, auth.org.orgId, auth.user.id, input.data, db);
      },
    );
    await audit({
      action: "ai.customer_memory_confirmed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: data.id,
      requestId,
    });
    return ok(data, { requestId });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (["customer_memory_forbidden", "customer_memory_owner_required"].includes(code))
      return fail("forbidden", "仅客户负责人或经理可直接确认。同事请先提出候选。", 403, {
        requestId,
      });
    if (
      [
        "customer_memory_contact_unavailable",
        "customer_memory_idempotency_conflict",
        "customer_memory_unlock_required",
        "customer_memory_replacement_unavailable",
        "customer_memory_conflict_requires_arbitration",
      ].includes(code)
    )
      return fail(
        "invalid_request",
        "Customer unavailable, request key conflicts, or explicit unlock/conflict resolution is required.",
        409,
        {
          requestId,
        },
      );
    return fail(
      "internal_error",
      "The save outcome is unconfirmed. Retry the same content with the same request_key; do not create a new key.",
      503,
      { requestId },
    );
  }
}
export async function DELETE(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({ id: z.string().uuid() })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!input.success) return fail("invalid_request", "Invalid memory ID.", 400, { requestId });
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    if (!(await deleteCustomerMemory(getRequestPool(), auth.org.orgId, input.data.id)))
      return fail("not_found", "Memory not found.", 404, { requestId });
    await audit({
      action: "ai.customer_memory_deleted",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: input.data.id,
      requestId,
    });
    return ok(
      { id: input.data.id, hidden: true, external_cleanup: "pending_verification" },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Unable to retire memory.", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({ id: z.string().uuid(), remote_request_settled: z.literal(true) })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "invalid_request",
      "Confirm in the Mem0 service that the earlier request has finished before reconciling.",
      400,
      { requestId },
    );
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const result = await reconcileCustomerMemory(getRequestPool(), auth.org.orgId, input.data.id);
    await audit({
      action: "ai.customer_memory_reconciled",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: input.data.id,
      requestId,
    });
    return ok(result, { requestId });
  } catch {
    return fail(
      "invalid_request",
      "Reconciliation is not yet safe, the service is unavailable, or duplicate remote receipts need operator review. No ADD was retried.",
      409,
      { requestId },
    );
  }
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({
      contact_id: z.string().uuid(),
      cursor: z.string().max(2048).optional(),
      conflicts_cursor: z.string().max(2048).optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success)
    return fail("invalid_request", "A contact ID is required.", 400, { requestId });
  const auth = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  try {
    const pool = getRequestPool();
    const capabilities = await customerMemoryCapabilities(
      pool,
      auth.org.orgId,
      input.data.contact_id,
      auth.user.id,
    );
    const binding = {
      org: auth.org.orgId,
      actor: auth.user.id,
      contact: input.data.contact_id,
      resource: "status",
    };
    const memoryAfter = input.data.cursor
      ? pagePosition.parse(decodeMemoryCursor(input.data.cursor, binding, env.INTERNAL_SECRET))
      : null;
    const conflictBinding = { ...binding, resource: "conflicts" };
    const conflictAfter = input.data.conflicts_cursor
      ? pagePosition.parse(
          decodeMemoryCursor(input.data.conflicts_cursor, conflictBinding, env.INTERNAL_SECRET),
        )
      : null;
    const { rows } = await pool.query(
      `select id,category,body,sync_state,write_outcome,deleted_at,remote_deleted_at,created_at,
       memory_type,risk_level,retention_policy,ttl_expires_at,review_due_at,locked,needs_review,review_reason,
       confirmed_by,confirmed_at,policy_revision,supersedes,evidence_conversation_id,
       coalesce(ttl_expires_at<=now(),false) expired,
       to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
       from ai_customer_memories where organization_id=$1 and contact_id=$2 and ($3::timestamptz is null or (created_at,id)<($3,$4::uuid)) order by created_at desc,id desc limit 101`,
      [auth.org.orgId, input.data.contact_id, memoryAfter?.at ?? null, memoryAfter?.id ?? null],
    );
    const conflicts = await pool.query(
      `select x.id,x.memory_id,x.other_memory_id,x.candidate_id,x.kind,x.created_at,x.business_field,
        m.body memory_body,m.policy_revision memory_revision,m.locked memory_locked,
        other.body other_body,other.policy_revision other_revision,other.locked other_locked,
        to_char(x.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
       from ai_customer_memory_conflicts x
       join ai_customer_memories m on m.organization_id=x.organization_id and m.contact_id=x.contact_id and m.id=x.memory_id and m.deleted_at is null
       left join ai_customer_memories other on other.organization_id=x.organization_id and other.contact_id=x.contact_id and other.id=x.other_memory_id
       where x.organization_id=$1 and x.contact_id=$2 and x.status='open' and ($3::timestamptz is null or (x.created_at,x.id)>($3,$4::uuid)) order by x.created_at,x.id limit 51`,
      [auth.org.orgId, input.data.contact_id, conflictAfter?.at ?? null, conflictAfter?.id ?? null],
    );
    const readable = await readableMemoryConversations(
      auth.org.orgId,
      rows.flatMap((row) =>
        row.evidence_conversation_id ? [String(row.evidence_conversation_id)] : [],
      ),
    );
    const contact = await pool.query(
      "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null",
      [auth.org.orgId, input.data.contact_id],
    );
    if (!contact.rows[0]) return fail("not_found", "客户不可用。", 404, { requestId });
    return ok(
      rows.slice(0, 100).map((row) => ({
        ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "cursor_at")),
        evidence_conversation_id: readable.has(String(row.evidence_conversation_id))
          ? row.evidence_conversation_id
          : null,
      })),
      {
        requestId,
        meta: {
          ...capabilities,
          has_more: rows.length > 100,
          cursor:
            rows.length > 100
              ? encodeMemoryCursor(
                  { at: rows[99]!.cursor_at, id: rows[99]!.id },
                  binding,
                  env.INTERNAL_SECRET,
                )
              : null,
          conflicts: conflicts.rows.slice(0, 50).map(({ cursor_at: _at, ...row }) => row),
          conflicts_has_more: conflicts.rows.length > 50,
          conflicts_cursor:
            conflicts.rows.length > 50
              ? encodeMemoryCursor(
                  { at: conflicts.rows[49]!.cursor_at, id: conflicts.rows[49]!.id },
                  conflictBinding,
                  env.INTERNAL_SECRET,
                )
              : null,
        },
      },
    );
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof Error && error.message === "memory_cursor_invalid")
    )
      return fail("invalid_request", "分页位置已失效，请刷新。", 400, { requestId });
    return fail("internal_error", "Unable to read customer memory status.", 503, { requestId });
  }
}
