import { z } from "zod";
import type { Contact } from "@/lib/types/contacts";

const timestamp = z.string().datetime({ offset: true });

/** A purpose-specific view of existing CRM fields; it never infers a profile. */
export function agentProfileContext(
  contact: Pick<
    Contact,
    | "id"
    | "birthdate"
    | "tags"
    | "consent"
    | "is_anonymized"
    | "is_merged_into"
    | "is_blocked"
    | "updated_at"
  >,
  now = Date.now(),
) {
  const base = {
    source: "crm_contact_fields" as const,
    authority: "customer_context_only" as const,
    purpose: "profiling" as const,
  };
  if (
    contact.is_anonymized !== false ||
    contact.is_merged_into !== null ||
    contact.is_blocked !== false
  )
    return { ...base, status: "unavailable" as const, reason: "contact_ineligible" as const };

  const consent = contact.consent?.profiling;
  const grant =
    typeof consent === "object" && consent !== null && !Array.isArray(consent)
      ? (consent as Record<string, unknown>)
      : null;
  const grantedAt = timestamp.safeParse(grant?.granted_at);
  // A loose truthy object, an invalid/future date or a retained old grant after
  // revocation must not turn into permission. Other consent purposes do not count.
  if (
    !grantedAt.success ||
    Date.parse(grantedAt.data) > now ||
    grant?.granted === false ||
    (grant?.revoked_at !== undefined && grant.revoked_at !== null && grant.revoked_at !== "")
  )
    return {
      ...base,
      status: "not_permitted" as const,
      reason: "profiling_consent_required" as const,
    };

  return {
    ...base,
    status: "available" as const,
    contact_id: contact.id,
    revision: contact.updated_at,
    consent_granted_at: grantedAt.data,
    profile: { birthdate: contact.birthdate, tags: contact.tags ?? [] },
  };
}
