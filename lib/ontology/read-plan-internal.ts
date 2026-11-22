import type pg from "pg";
import { ensureRole, ensureScope, ensureToolGrant, scopesRole } from "@/lib/mcp/auth";
import { isMcpToolGranted } from "@/lib/mcp/tool-grants";
import { planHash, validateReadPlan } from "./query-plan";

/** Server-only seam: identity is established by an authentication gate, never model input. */
export async function executeWithIdentity(
  pool: pg.Pool,
  input: unknown,
  identity: {
    userId: string;
    organizationId: string;
    aal: "aal1" | "aal2";
    pipelineIds?: readonly string[] | null;
    apiTokenId?: string;
    runtime?: {
      tokenId: string;
      agentId: string;
      versionId: string;
      runId: string;
      workbenchRunId?: string;
    };
  },
  signal?: AbortSignal,
) {
  const plan = validateReadPlan(input);
  if (signal?.aborted) throw new Error("ontology_cancelled");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8000);
  const cancel = () => timeout.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) timeout.abort();
  const acquiring = pool.connect();
  let client: pg.PoolClient;
  try {
    client = await Promise.race([
      acquiring,
      new Promise<never>((_, reject) => {
        const rejectCancelled = () => reject(new Error("ontology_cancelled"));
        if (timeout.signal.aborted) rejectCancelled();
        else timeout.signal.addEventListener("abort", rejectCancelled, { once: true });
      }),
    ]);
  } catch {
    void acquiring.then(
      (c) => c.release(),
      () => undefined,
    );
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    throw new Error(
      signal?.aborted
        ? "ontology_cancelled"
        : timeout.signal.aborted
          ? "ontology_timeout"
          : "ontology_read_unavailable",
    );
  }
  let broken = false;
  const abort = () => {
    broken = true;
    client.release(true);
  };
  // The connection is discarded on cancellation; no other pooled request may reuse it.
  timeout.signal.addEventListener("abort", abort, { once: true });
  try {
    if (timeout.signal.aborted) throw new Error("ontology_cancelled");
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '5s'");
    await client.query("set local lock_timeout = '1s'");
    let tokenCeiling = false;
    if (identity.apiTokenId) {
      const token = await client.query<{ created_by: string; scopes: unknown }>(
        `select created_by, scopes from public.api_tokens where id=$1::uuid and organization_id=$2::uuid
         and revoked_at is null and (expires_at is null or expires_at > now())`,
        [identity.apiTokenId, identity.organizationId],
      );
      const row = token.rows[0];
      if (!row || !Array.isArray(row.scopes)) throw new Error("ontology_forbidden");
      const scopes = row.scopes.filter((s): s is string => typeof s === "string");
      try {
        ensureScope(scopes, "mcp:read");
        ensureRole(scopesRole(scopes), "agent");
        ensureToolGrant(scopes, "ontology_query");
      } catch {
        throw new Error("ontology_forbidden");
      }
      if (scopes.includes("actor:ai_agent")) throw new Error("ontology_forbidden");
      identity = { ...identity, userId: row.created_by };
      tokenCeiling = true;
    }
    if (identity.runtime) {
      const runtime = identity.runtime;
      const binding = await client.query<{
        created_by: string;
        scopes: unknown;
        pipeline_ids: string[];
        workbench_pipeline: string | null;
        workbench_unscoped: boolean;
      }>(
        `select t.created_by, t.scopes, v.pipeline_ids,
         (select r.scope->>'pipelineId' from public.ai_workbench_runs r
           where r.id=$6::uuid and r.organization_id=a.organization_id and r.agent_id=a.id
             and r.status='running' and r.runtime_state->>'versionId'=v.id::text
             and not (r.scope ?| array['contactId','leadId','conversationId'])
             and ($6::uuid=$7::uuid or exists (select 1 from public.job_queue j
               where j.id=$7::uuid and j.organization_id=r.organization_id
                 and j.status='running' and j.payload->>'runId'=r.id::text))) as workbench_pipeline,
         exists (select 1 from public.ai_workbench_runs r
           where r.id=$6::uuid and r.organization_id=a.organization_id and r.agent_id=a.id
             and r.status='running' and r.runtime_state->>'versionId'=v.id::text
             and not (r.scope ?| array['pipelineId','contactId','leadId','conversationId'])
             and ($6::uuid=$7::uuid or exists (select 1 from public.job_queue j
               where j.id=$7::uuid and j.organization_id=r.organization_id
                 and j.status='running' and j.payload->>'runId'=r.id::text))) as workbench_unscoped
         from public.api_tokens t
         join public.ai_agents a on a.id = $2::uuid and a.organization_id = t.organization_id
         join public.ai_agent_versions v on v.id = $3::uuid and v.agent_id = a.id and v.organization_id = t.organization_id
         where t.id = $1::uuid and t.organization_id = $4::uuid and t.revoked_at is null
           and (t.expires_at is null or t.expires_at > now())
           and t.scopes @> $5::jsonb and a.archived_at is null
           and ((a.published_version_id = v.id and v.status = 'published') or (
             $6::uuid is not null and a.origin = 'builtin' and a.model_binding_mode = 'organization_default'
             and a.builtin_key is not null and v.status = 'draft'
             and exists (select 1 from public.ai_workbench_runs r
               where r.id = $6::uuid and r.organization_id = a.organization_id and r.agent_id = a.id
                 and r.status = 'running' and r.runtime_state->>'versionId' = v.id::text
                 and ($6::uuid = $7::uuid or exists (select 1 from public.job_queue j
                   where j.id = $7::uuid and j.organization_id = r.organization_id
                     and j.status = 'running' and j.payload->>'runId' = r.id::text)))
           ))`,
        [
          runtime.tokenId,
          runtime.agentId,
          runtime.versionId,
          identity.organizationId,
          JSON.stringify([
            "mcp:read",
            "actor:ai_agent",
            "role:ai_operator",
            `agent_run:${runtime.runId}`,
          ]),
          runtime.workbenchRunId ?? null,
          runtime.runId,
        ],
      );
      const current = binding.rows[0];
      if (!current || identity.pipelineIds === undefined || !Array.isArray(current.scopes)) {
        throw new Error("ontology_forbidden");
      }
      const currentScopes = current.scopes.filter((scope): scope is string => typeof scope === "string");
      if (!isMcpToolGranted(currentScopes, "ontology_query")) throw new Error("ontology_forbidden");
      if (identity.pipelineIds === null) {
        if (!current.workbench_unscoped) throw new Error("ontology_forbidden");
      } else if (runtime.workbenchRunId) {
        if (!current.workbench_pipeline && identity.pipelineIds.length > 0)
          throw new Error("ontology_forbidden");
        identity = {
          ...identity,
          pipelineIds: identity.pipelineIds.filter((id) => id === current.workbench_pipeline),
        };
      } else {
        const allowed = new Set(current.pipeline_ids);
        identity = {
          ...identity,
          pipelineIds: identity.pipelineIds.filter((id) => allowed.has(id)),
        };
      }
      identity = { ...identity, userId: current.created_by };
      tokenCeiling = true;
    }
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: identity.userId, role: "authenticated", aal: identity.aal }),
    ]);
    const membership = await client.query<{ role: string | null }>(
      "select public.fn_user_role_in_org($1::uuid) as role",
      [identity.organizationId],
    );
    if (!membership.rows[0]?.role) throw new Error("ontology_forbidden");
    // The application credential may write; the query itself executes as a
    // column-limited, non-bypass role with RLS enforced.
    await client.query("set local role ontology_reader");
    const roleSafety = await client.query<{ safe: boolean }>(
      `select not (r.rolsuper or r.rolbypassrls or r.rolcanlogin or r.rolcreaterole or r.rolcreatedb or r.rolinherit)
         and not exists (select 1 from unnest(array['public.crm_leads','public.crm_tasks','public.contacts','public.crm_lead_activities','public.organizations']) t
          where has_table_privilege(current_user, t, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
             or has_any_column_privilege(current_user, t, 'INSERT,UPDATE')) as safe
       from pg_roles r where r.rolname=current_user`,
    );
    if (!roleSafety.rows[0]?.safe) throw new Error("ontology_forbidden");
    // A token can never exceed its creator's access or the agent visibility mode.
    // This is a ceiling; the creator is not the actor recorded by MCP.
    // The task table allows cross-tenant FKs. Check scope at every endpoint;
    // inaccessible or inconsistent links are omitted, and the receipt is partial.
    const result =
      plan.template === "open_opportunities_v1"
        ? await client.query(
            `select id, status, value_cents, currency from public.crm_leads
         where organization_id = $1::uuid and status = 'open'
           and public.fn_can_view_lead(organization_id, owner_user_id)
           and ($2::uuid[] is null or pipeline_id = any($2::uuid[]))
           and ($3::boolean = false or coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'all' or owner_user_id = $4::uuid or (coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'own_and_unassigned' and owner_user_id is null)) order by id limit 101`,
            [identity.organizationId, identity.pipelineIds ?? null, tokenCeiling, identity.userId],
          )
        : plan.template === "explicit_activity_gap_v1"
          ? await client.query(
              `select l.id, l.status, l.value_cents, l.currency from public.crm_leads l
         where l.organization_id = $1::uuid and l.status = 'open'
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
           and ($7::uuid[] is null or l.pipeline_id = any($7::uuid[]))
           and ($8::boolean = false or coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'all' or l.owner_user_id = $9::uuid or (coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'own_and_unassigned' and l.owner_user_id is null))
           and l.value_cents >= $2 and l.currency = $3
           and not exists (select 1 from public.crm_lead_activities a
             where a.organization_id = l.organization_id and a.lead_id = l.id
               and a.performed_at >= $4::timestamptz and a.performed_at < $5::timestamptz
               and a.type = any($6::text[])) order by l.id limit 101`,
              [
                identity.organizationId,
                plan.criteria.minimumValueCents,
                plan.criteria.currency,
                plan.criteria.from,
                plan.criteria.to,
                plan.criteria.activityTypes,
                identity.pipelineIds ?? null,
                tokenCeiling,
                identity.userId,
              ],
            )
          : await client.query(
              `select t.id, t.status, t.due_date,
          (t.lead_id is null or exists (select 1 from public.crm_leads l
            where l.id = t.lead_id and l.organization_id = t.organization_id
              and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
              and ($2::uuid[] is null or l.pipeline_id = any($2::uuid[]))
              and ($3::boolean = false or coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'all' or l.owner_user_id = $4::uuid or (coalesce((select o.settings->>'visibility_mode' from public.organizations o where o.id = $1::uuid), 'own_and_unassigned') = 'own_and_unassigned' and l.owner_user_id is null))))
          and (t.contact_id is null or exists (select 1 from public.contacts c
            where c.id = t.contact_id and c.organization_id = t.organization_id)) as visible_links
         from public.crm_tasks t where t.organization_id = $1::uuid and t.due_date is null
         and ($2::uuid[] is null or t.lead_id is not null)
         order by t.id limit 101`,
              [
                identity.organizationId,
                identity.pipelineIds ?? null,
                tokenCeiling,
                identity.userId,
              ],
            );
    await client.query("commit");
    const safeRows = result.rows
      .filter((row) => row.visible_links !== false)
      .map(({ visible_links: _ignored, ...row }) => row);
    const partial =
      (tokenCeiling && (!identity.runtime || plan.template !== "open_opportunities_v1")) ||
      (identity.pipelineIds != null && identity.pipelineIds.length === 0) ||
      plan.template === "explicit_activity_gap_v1" ||
      result.rows.length > plan.limit ||
      safeRows.length !== result.rows.length;
    return {
      rows: safeRows.slice(0, plan.limit),
      receipt: {
        ontologyVersion: plan.ontologyVersion,
        ontologyDigest: plan.ontologyDigest,
        planHash: planHash(plan),
        template: plan.template,
        relations:
          plan.template === "tasks_without_due_v1"
            ? ["task_opportunity", "task_contact"]
            : plan.template === "explicit_activity_gap_v1"
              ? ["activity_opportunity"]
              : [],
        metrics: [],
        sources:
          plan.template === "tasks_without_due_v1"
            ? ["crm_tasks", "crm_leads", "contacts"]
            : plan.template === "explicit_activity_gap_v1"
              ? ["crm_leads", "crm_lead_activities"]
              : ["crm_leads"],
        rowCount: Math.min(safeRows.length, plan.limit),
        rowLimit: plan.limit,
        partial,
        criteria: plan.template === "explicit_activity_gap_v1" ? plan.criteria : null,
        effectivePipelineIds: identity.pipelineIds ?? null,
        visibility: tokenCeiling
          ? "Visibilidade do criador do token e RLS, dentro do escopo solicitado; não representa toda a organização."
          : "Visibilidade da sessão autenticada.",
        caveat:
          plan.template === "explicit_activity_gap_v1"
            ? "Critérios explícitos não certificam follow-up válido nem completude histórica; valores e moedas ausentes são excluídos."
            : null,
        scope:
          plan.template === "tasks_without_due_v1"
            ? "all task statuses; no due date"
            : "open; includes all pipeline and stage archive states",
      },
    };
  } catch (error) {
    if (!broken)
      await client.query("rollback").catch(() => {
        broken = true;
        client.release(true);
      });
    if (timeout.signal.aborted)
      throw new Error(signal?.aborted ? "ontology_cancelled" : "ontology_timeout");
    if (error instanceof Error && error.message === "ontology_forbidden") throw error;
    throw new Error("ontology_read_failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    timeout.signal.removeEventListener("abort", abort);
    if (!broken) client.release();
  }
}
