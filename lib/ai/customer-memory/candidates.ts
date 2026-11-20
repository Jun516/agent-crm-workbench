import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { saveCustomerMemory } from "@/lib/ai/integrations/mem0";
import { assertMemoryAuthority, withMemoryContact } from "./authority";
import { memoryPolicyInput, memoryTypes, resolveMemoryPolicy } from "./policy";

const evidenceInput = z
  .object({ message_id: z.string().uuid(), excerpt: z.string().min(1).max(2000) })
  .strict();
export const proposeMemoryInput = z
  .object({
    contact_id: z.string().uuid(),
    request_key: z.string().uuid(),
    category: z.enum(["preference", "confirmed_fact", "communication_context"]),
    memory_type: z.enum(memoryTypes),
    body: z.string().trim().min(1).max(2000),
    attribute_key: z.string().max(120).optional(),
    attribute_value: z.string().max(300).optional(),
    ttl_expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    evidence: z.array(evidenceInput).max(8).default([]),
    conflicts_with: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();
export type ProposeMemoryInput = z.infer<typeof proposeMemoryInput>;
export interface CandidateSource {
  kind: "explicit" | "conversation_close" | "checkpoint" | "workbench_complete";
  actor: string | null;
  confidence?: number;
  runId?: string;
  beforeWrite?: (db: PoolClient) => Promise<void>;
}
interface CandidateRow {
  id: string;
  organization_id: string;
  contact_id: string;
  category: "preference" | "confirmed_fact" | "communication_context";
  memory_type: (typeof memoryTypes)[number];
  body: string;
  attribute_key: string | null;
  attribute_value: string | null;
  ttl_expires_at: string | Date | null;
  normalized_hash: string;
  status: string;
  confirmed_memory_id: string | null;
  revision_token: string;
  decision_reason: string | null;
  rejected_until: string | Date | null;
  merged_into: string | null;
}
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[。.!?]+$/gu, "");
export function candidateFingerprint(
  input: Pick<ProposeMemoryInput, "memory_type" | "body" | "attribute_key" | "attribute_value"> &
    Partial<Pick<ProposeMemoryInput, "ttl_expires_at">>,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.memory_type,
        input.attribute_key ?? null,
        input.attribute_value ? normalize(input.attribute_value) : normalize(input.body),
        input.memory_type === "temporary_request" ? (input.ttl_expires_at ?? null) : null,
      ]),
    )
    .digest("hex");
}
async function appendEvidence(
  db: PoolClient,
  org: string,
  contact: string,
  candidate: string,
  evidence: {
    conversation: string | null;
    message: string | null;
    excerpt: string;
    at: string | Date;
  }[],
) {
  for (const e of evidence)
    await db.query(
      `insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,conversation_id,message_id,excerpt,observed_at)
     select $1,$2,$3,$4,$5,$6,$7 where not exists (
       select 1 from ai_customer_memory_evidence where organization_id=$1 and contact_id=$2 and candidate_id=$3
         and message_id is not distinct from $5::uuid and excerpt=$6
     ) on conflict do nothing`,
      [org, contact, candidate, e.conversation, e.message, e.excerpt, e.at],
    );
}
async function attachConflicts(
  db: PoolClient,
  org: string,
  contact: string,
  candidate: CandidateRow,
  specified: string[],
) {
  const existing = await db.query<{ id: string }>(
    `select id from ai_customer_memories where organization_id=$1 and contact_id=$2 and deleted_at is null
     and (ttl_expires_at is null or ttl_expires_at>now()) and (
       id=any($3::uuid[]) or (attribute_key=$4 and attribute_value<>$5)
     )`,
    [org, contact, specified, candidate.attribute_key, candidate.attribute_value],
  );
  for (const memory of existing.rows)
    await db.query(
      `insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,candidate_id,kind,conflict_key)
     values($1,$2,$3,$4,'l2_l1',$5) on conflict(organization_id,contact_id,conflict_key) do nothing`,
      [org, contact, memory.id, candidate.id, `candidate:${candidate.id}:${memory.id}`],
    );
}

/** Extraction may call only this L2 writer. There is deliberately no promotion flag. */
export async function proposeCustomerMemory(
  pool: Pool,
  org: string,
  input: ProposeMemoryInput,
  source: CandidateSource,
) {
  const parsed = proposeMemoryInput.parse(input);
  const policy = resolveMemoryPolicy({
    memory_type: parsed.memory_type,
    attribute_key: parsed.attribute_key,
    attribute_value: parsed.attribute_value,
    ttl_expires_at: parsed.ttl_expires_at,
  });
  if (source.kind === "explicit" && !source.actor)
    throw new Error("customer_memory_actor_required");
  if (source.kind !== "explicit" && !parsed.evidence.length)
    throw new Error("customer_memory_evidence_required");
  if (source.kind !== "explicit") z.number().min(0).max(1).parse(source.confidence);
  return withMemoryContact(pool, org, parsed.contact_id, async (db) => {
    await source.beforeWrite?.(db);
    if (source.actor)
      await assertMemoryAuthority(db, org, parsed.contact_id, source.actor, "propose");
    if (source.runId) {
      const run = await db.query(
        "select id from ai_workbench_runs where organization_id=$1 and id=$2 and scope->>'contactId'=$3",
        [org, source.runId, parsed.contact_id],
      );
      if (!run.rows.length) throw new Error("customer_memory_source_unavailable");
    }
    const proof: {
      conversation: string | null;
      message: string | null;
      excerpt: string;
      at: string | Date;
    }[] = [];
    for (const e of parsed.evidence) {
      const message = await db.query<{ conversation_id: string; created_at: Date }>(
        `select conversation_id,created_at from messages where organization_id=$1 and contact_id=$2 and id=$3
         and direction='inbound' and revoked_at is null and position($4 in coalesce(body,''))>0`,
        [org, parsed.contact_id, e.message_id, e.excerpt],
      );
      if (!message.rows[0]) throw new Error("customer_memory_evidence_unavailable");
      proof.push({
        conversation: message.rows[0].conversation_id,
        message: e.message_id,
        excerpt: e.excerpt,
        at: message.rows[0].created_at,
      });
    }
    if (!proof.length)
      proof.push({ conversation: null, message: null, excerpt: parsed.body, at: new Date() });
    const fingerprint = candidateFingerprint(parsed);
    const previous = await db.query<CandidateRow>(
      "select *,updated_at::text revision_token from ai_customer_memory_candidates where organization_id=$1 and request_key=$2 for update",
      [org, parsed.request_key],
    );
    if (previous.rows[0]) {
      const prior = previous.rows[0];
      if (
        prior.contact_id !== parsed.contact_id ||
        prior.normalized_hash !== fingerprint ||
        (source.kind === "explicit" && prior.body !== parsed.body) ||
        prior.category !== parsed.category ||
        (prior.ttl_expires_at ? new Date(prior.ttl_expires_at).toISOString() : null) !==
          policy.ttl_expires_at
      )
        throw new Error("customer_memory_idempotency_conflict");
      return {
        id: prior.id,
        status: prior.status,
        deduped: true,
        revision_token: prior.revision_token,
      };
    }
    const suppressed = await db.query<{ id: string }>(
      `select id from ai_customer_memory_candidates where organization_id=$1 and contact_id=$2 and normalized_hash=$3
       and status='rejected' and rejected_until>now() and deleted_at is null order by rejected_until desc limit 1`,
      [org, parsed.contact_id, fingerprint],
    );
    if (suppressed.rows[0])
      return { id: suppressed.rows[0].id, status: "suppressed", deduped: true };
    const known = await db.query<{ id: string }>(
      `select id from ai_customer_memories where organization_id=$1 and contact_id=$2 and deleted_at is null
       and not needs_review and (review_due_at is null or review_due_at>now())
       and (ttl_expires_at is null or ttl_expires_at>now()) and memory_type=$3
       and (body=$4 or (attribute_key=$5 and lower(trim(attribute_value))=lower(trim($6)))) limit 1`,
      [
        org,
        parsed.contact_id,
        policy.memory_type,
        parsed.body,
        policy.attribute_key,
        policy.attribute_value,
      ],
    );
    if (known.rows[0]) return { id: known.rows[0].id, status: "already_confirmed", deduped: true };
    const pending = await db.query<CandidateRow>(
      `select *,updated_at::text revision_token from ai_customer_memory_candidates where organization_id=$1 and contact_id=$2
       and normalized_hash=$3 and status='pending' and deleted_at is null for update`,
      [org, parsed.contact_id, fingerprint],
    );
    let candidate = pending.rows[0];
    if (!candidate) {
      const created = await db.query<CandidateRow>(
        `insert into ai_customer_memory_candidates(organization_id,contact_id,request_key,category,memory_type,body,
         attribute_key,attribute_value,risk_level,ttl_expires_at,model_confidence,normalized_hash,source_kind,source_run_id,proposed_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *,updated_at::text revision_token`,
        [
          org,
          parsed.contact_id,
          parsed.request_key,
          parsed.category,
          policy.memory_type,
          parsed.body,
          policy.attribute_key,
          policy.attribute_value,
          policy.risk_level,
          policy.ttl_expires_at,
          source.confidence ?? null,
          fingerprint,
          source.kind,
          source.runId ?? null,
          source.actor,
        ],
      );
      candidate = created.rows[0]!;
    }
    await appendEvidence(db, org, parsed.contact_id, candidate.id, proof);
    await attachConflicts(db, org, parsed.contact_id, candidate, parsed.conflicts_with);
    return {
      id: candidate.id,
      status: "pending",
      deduped: Boolean(pending.rows[0]),
      revision_token: candidate.revision_token,
    };
  });
}

export const decideMemoryInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("confirm"),
      id: z.string().uuid(),
      revision_token: z.string().min(1).max(100),
      body: z.string().trim().min(1).max(2000).optional(),
      policy: memoryPolicyInput.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reject"),
      id: z.string().uuid(),
      revision_token: z.string().min(1).max(100),
      reason: z.string().trim().min(1).max(1000),
      rejected_until: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal("merge"),
      id: z.string().uuid(),
      revision_token: z.string().min(1).max(100),
      target_id: z.string().uuid(),
    })
    .strict(),
]);
export async function decideCustomerMemory(
  pool: Pool,
  org: string,
  actor: string,
  raw: z.infer<typeof decideMemoryInput>,
) {
  const input = decideMemoryInput.parse(raw);
  const found = await pool.query<{ contact_id: string }>(
    "select contact_id from ai_customer_memory_candidates where organization_id=$1 and id=$2 and deleted_at is null",
    [org, input.id],
  );
  if (!found.rows[0]) throw new Error("customer_memory_candidate_unavailable");
  const contact = found.rows[0].contact_id;
  return withMemoryContact(pool, org, contact, async (db) => {
    await assertMemoryAuthority(db, org, contact, actor, "confirm");
    const result = await db.query<CandidateRow>(
      "select *,updated_at::text revision_token from ai_customer_memory_candidates where organization_id=$1 and contact_id=$2 and id=$3 and deleted_at is null for update",
      [org, contact, input.id],
    );
    const candidate = result.rows[0];
    if (
      !candidate ||
      candidate.status !== "pending" ||
      candidate.revision_token !== input.revision_token
    )
      throw new Error("customer_memory_candidate_changed");
    if (input.action === "reject") {
      if (Date.parse(input.rejected_until) <= Date.now())
        throw new Error("customer_memory_cooldown_required");
      await db.query(
        `update ai_customer_memory_candidates set status='rejected',decision_reason=$4,rejected_until=$5,
        decided_by=$6,decided_at=now(),updated_at=now() where organization_id=$1 and contact_id=$2 and id=$3`,
        [org, contact, input.id, input.reason, input.rejected_until, actor],
      );
      await db.query(
        `update ai_customer_memory_conflicts set status='resolved',resolution='candidate_rejected',resolved_by=$4,resolved_at=now()
        where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'`,
        [org, contact, input.id, actor],
      );
      return { id: input.id, status: "rejected" };
    }
    if (input.action === "merge") {
      if (input.target_id === input.id) throw new Error("customer_memory_merge_invalid");
      const target = (
        await db.query<CandidateRow>(
          "select * from ai_customer_memory_candidates where organization_id=$1 and contact_id=$2 and id=$3 and status='pending' and deleted_at is null for update",
          [org, contact, input.target_id],
        )
      ).rows[0];
      if (
        !target ||
        target.memory_type !== candidate.memory_type ||
        target.attribute_key !== candidate.attribute_key ||
        (candidate.memory_type === "temporary_request" &&
          new Date(target.ttl_expires_at!).getTime() !==
            new Date(candidate.ttl_expires_at!).getTime()) ||
        (target.attribute_value &&
          candidate.attribute_value &&
          normalize(target.attribute_value) !== normalize(candidate.attribute_value))
      )
        throw new Error("customer_memory_merge_invalid");
      const proof = await db.query<{
        conversation: string | null;
        message: string | null;
        excerpt: string;
        at: Date;
      }>(
        'select conversation_id conversation,message_id message,excerpt,observed_at as "at" from ai_customer_memory_evidence where organization_id=$1 and contact_id=$2 and candidate_id=$3',
        [org, contact, input.id],
      );
      await appendEvidence(db, org, contact, target.id, proof.rows);
      const conflicts = await db.query<{ memory_id: string }>(
        "select memory_id from ai_customer_memory_conflicts where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'",
        [org, contact, input.id],
      );
      await attachConflicts(
        db,
        org,
        contact,
        target,
        conflicts.rows.map((r) => r.memory_id),
      );
      await db.query(
        `update ai_customer_memory_candidates set status='merged',merged_into=$4,decided_by=$5,decided_at=now(),updated_at=now()
        where organization_id=$1 and contact_id=$2 and id=$3`,
        [org, contact, input.id, target.id, actor],
      );
      await db.query(
        `update ai_customer_memory_candidates set updated_at=now() where organization_id=$1 and contact_id=$2 and id=$3`,
        [org, contact, target.id],
      );
      await db.query(
        `update ai_customer_memory_conflicts set status='resolved',resolution='candidate_merged',resolved_by=$4,resolved_at=now()
        where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'`,
        [org, contact, input.id, actor],
      );
      return { id: input.id, status: "merged", merged_into: target.id };
    }
    const conflicts = await db.query<{ memory_id: string }>(
      "select memory_id from ai_customer_memory_conflicts where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'",
      [org, contact, input.id],
    );
    if (conflicts.rows.length) {
      await assertMemoryAuthority(db, org, contact, actor, "arbitrate");
      if (
        !input.policy?.supersedes ||
        conflicts.rows.some((c) => c.memory_id !== input.policy?.supersedes)
      )
        throw new Error("customer_memory_conflict_requires_arbitration");
    }
    const expires = candidate.ttl_expires_at
      ? new Date(candidate.ttl_expires_at).toISOString()
      : null;
    const policy = {
      memory_type: candidate.memory_type,
      attribute_key: candidate.attribute_key ?? undefined,
      attribute_value: candidate.attribute_value ?? undefined,
      ttl_expires_at: expires,
      ...input.policy,
    };
    const saved = await saveCustomerMemory(
      pool,
      org,
      actor,
      {
        contact_id: contact,
        request_key: candidate.id,
        category: candidate.category,
        body: input.body ?? candidate.body,
        confirmed: true,
        ...policy,
      },
      db,
    );
    const evidence = await db.query<{ conversation_id: string }>(
      "select conversation_id from ai_customer_memory_evidence where organization_id=$1 and contact_id=$2 and candidate_id=$3 and conversation_id is not null order by observed_at limit 1",
      [org, contact, candidate.id],
    );
    await db.query(
      "update ai_customer_memories set evidence_conversation_id=$4 where organization_id=$1 and contact_id=$2 and id=$3",
      [org, contact, saved.id, evidence.rows[0]?.conversation_id ?? null],
    );
    await db.query(
      `update ai_customer_memory_candidates set status='confirmed',confirmed_memory_id=$4,decided_by=$5,decided_at=now(),updated_at=now()
      where organization_id=$1 and contact_id=$2 and id=$3`,
      [org, contact, candidate.id, saved.id, actor],
    );
    await db.query(
      `update ai_customer_memory_conflicts set status='resolved',resolution='explicit_replacement',resolved_by=$4,resolved_at=now()
      where organization_id=$1 and contact_id=$2 and candidate_id=$3 and status='open'`,
      [org, contact, candidate.id, actor],
    );
    return { id: candidate.id, status: "confirmed", memory_id: saved.id };
  });
}
