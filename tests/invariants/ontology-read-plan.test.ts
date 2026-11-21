import pg from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeMcpReadPlan } from "@/lib/ontology/execute-mcp-read-plan";
import { executeRuntimeReadPlan } from "@/lib/ontology/execute-runtime-read-plan";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { executeWithIdentity } from "@/lib/ontology/read-plan-internal";
import { planExplicitActivityGap, planQuery } from "@/lib/ontology/query-plan";
import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  GOV_CONTACT_1,
  seedGov,
  sql,
} from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
const ids = [
  "a3300000-0000-4000-8000-000000000001",
  "a3300000-0000-4000-8000-000000000002",
  "a3300000-0000-4000-8000-000000000003",
];
const secondPipeline = "a3300000-0000-4000-8000-000000000014";
const secondStage = "a3300000-0000-4000-8000-000000000015";
const secondLead = "a3300000-0000-4000-8000-000000000016";
const runtimeAgent = "a3300000-0000-4000-8000-000000000010";
const runtimeVersion = "a3300000-0000-4000-8000-000000000011";
const runtimeRun = "a3300000-0000-4000-8000-000000000012";
const externalToken = "a3300000-0000-4000-8000-000000000017";
const runtimeToken = "a3300000-0000-4000-8000-000000000013";
const other = "a3300000-0000-4000-8000-000000000004";
const foreignContact = "a3300000-0000-4000-8000-000000000005";
const plan = planQuery("Quais negócios estão abertos?")!;
const ident = (userId: string, organizationId = GOV_ORG) => ({
  userId,
  organizationId,
  aal: "aal1" as const,
});
beforeAll(() => {
  seedGov();
  sql(`create role ontology_worker login password 'synthetic' bypassrls;
    grant usage on schema public to ontology_worker;
    grant select, insert, update, delete on all tables in schema public to ontology_worker;
    grant usage, select on all sequences in schema public to ontology_worker;
    grant execute on all functions in schema public to ontology_worker;
    grant ontology_reader to ontology_worker;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, value_cents, currency)
    values ('${ids[0]}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic A','${GOV_AGENT_A}',100000,'BRL'),
      ('${ids[1]}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic B','${GOV_AGENT_B}',200000,'USD'),
      ('${ids[2]}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic null',null,null,'BRL');
    update public.crm_leads set contact_id='${GOV_CONTACT_1}' where id in ('${ids[0]}','${ids[1]}');
    insert into public.organizations(id,slug,legal_name,display_name) values ('${other}','ontology-33-test','Synthetic','Synthetic');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title) select 'a3300000-0000-4000-8000-000000000018','${other}',p.id,s.id,'Synthetic other org' from crm_pipelines p join crm_stages s on s.pipeline_id=p.id where p.organization_id='${other}' and not s.is_won and not s.is_lost limit 1;
    insert into public.contacts(id,organization_id,display_name) values ('${foreignContact}','${other}','Synthetic foreign');
    insert into public.crm_pipelines(id,organization_id,name,slug) values ('${secondPipeline}','${GOV_ORG}','Synthetic second','ontology-second');
    insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values ('${secondStage}','${GOV_ORG}','${secondPipeline}','Synthetic','synthetic',1000);
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title,value_cents,currency) values ('${secondLead}','${GOV_ORG}','${secondPipeline}','${secondStage}','Synthetic other pipeline',150000,'BRL');
    insert into public.ai_agents(id,organization_id,name,system_prompt,kind) values ('${runtimeAgent}','${GOV_ORG}','Synthetic','Synthetic','mcp_agent');
    insert into public.ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,pipeline_ids)
      values ('${runtimeVersion}','${GOV_ORG}','${runtimeAgent}',1,'Synthetic','test','test','published',ARRAY['${GOV_PIPELINE}'::uuid]);
    update public.ai_agents set published_version_id='${runtimeVersion}' where id='${runtimeAgent}';
    insert into public.api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes,expires_at)
      values ('${runtimeToken}','${GOV_ORG}','${GOV_MANAGER}','Synthetic','ont33',decode(md5('synthetic'),'hex'),
        '["mcp:read","actor:ai_agent","role:ai_operator","agent_run:${runtimeRun}"]'::jsonb,now()+interval '1 hour');
    insert into public.api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes,expires_at)
      values ('${externalToken}','${GOV_ORG}','${GOV_MANAGER}','Synthetic external','ont33-external',decode(md5('synthetic-external'),'hex'),'["mcp:read"]'::jsonb,now()+interval '1 hour');
    insert into public.crm_tasks(id,organization_id,title,contact_id) values
      ('a3300000-0000-4000-8000-000000000006','${GOV_ORG}','Synthetic bad link','${foreignContact}'),
      ('a3300000-0000-4000-8000-000000000007','${GOV_ORG}','Synthetic no links',null);`);
});
process.env.SUPABASE_DB_URL = `postgresql://ontology_worker:synthetic@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`;
afterAll(async () => {
  await pool.end();
  await getRequestPool().end();
});
describe("read plan against pg15", () => {
  it("uses live MCP token scope and a conservative agent visibility ceiling", async () => {
    const context = {
      organizationId: GOV_ORG,
      role: "agent",
      actor: { type: "api_token", id: externalToken, role: "agent" },
      apiTokenId: externalToken,
      requestId: runtimeRun,
      supabase: {},
    } as Parameters<typeof executeMcpReadPlan>[1];
    const result = await executeMcpReadPlan(plan, context);
    expect(result.rows.some((row) => row.id === ids[0])).toBe(false);
    expect(result.rows.some((row) => row.id === ids[2])).toBe(true);
    expect(result.receipt.partial).toBe(true);
    await expect(executeMcpReadPlan(plan, { ...context, organizationId: other })).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(`update public.api_tokens set scopes='["mcp:read","mcp:tools:restricted","mcp:tool:crm_get_lead"]'::jsonb where id='${externalToken}'`);
    await expect(executeMcpReadPlan(plan, context)).rejects.toThrow("ontology_forbidden");
    sql(`update public.api_tokens set scopes='["mcp:read","mcp:tools:restricted","mcp:tool:ontology_query"]'::jsonb where id='${externalToken}'`);
    expect((await executeMcpReadPlan(plan, context)).rows.some((row) => row.id === ids[2])).toBe(true);
    sql(`update public.api_tokens set scopes='[]'::jsonb where id='${externalToken}'`);
    await expect(executeMcpReadPlan(plan, context)).rejects.toThrow("ontology_forbidden");
  });
  it("allows only the active trusted workbench run to use its own builtin draft", async () => {
    const draft = "a3300000-0000-4000-8000-000000000019";
    sql(`update public.ai_agents set origin='builtin', builtin_key='crm_intelligence', model_binding_mode='organization_default' where id='${runtimeAgent}';
      insert into public.ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,pipeline_ids)
      values ('${draft}','${GOV_ORG}','${runtimeAgent}',2,'Synthetic','test','test','draft',ARRAY[]::uuid[]);
      insert into public.ai_workbench_runs(id,organization_id,agent_id,task,mode,status,runtime_state,scope)
      values ('${runtimeRun}','${GOV_ORG}','${runtimeAgent}','Synthetic','inspect','running',jsonb_build_object('versionId','${draft}'),jsonb_build_object('pipelineId','${GOV_PIPELINE}'));`);
    const context = {
      organizationId: GOV_ORG,
      role: "ai_operator",
      actor: {
        type: "ai_agent",
        id: runtimeRun,
        agent_id: runtimeAgent,
        api_token_id: runtimeToken,
      },
      apiTokenId: runtimeToken,
      requestId: runtimeRun,
      supabase: {},
    } as Parameters<typeof executeRuntimeReadPlan>[1];
    const runtime = {
      versionId: draft,
      runId: runtimeRun,
      workbenchRunId: runtimeRun,
      pipelineIds: [GOV_PIPELINE],
    };
    expect(
      (await executeRuntimeReadPlan(plan, context, runtime)).receipt.effectivePipelineIds,
    ).toEqual([GOV_PIPELINE]);
    const outside = await executeRuntimeReadPlan(plan, context, {
      ...runtime,
      pipelineIds: [secondPipeline],
    });
    expect(outside.rows).toEqual([]);
    expect(outside.receipt.effectivePipelineIds).toEqual([]);
    await expect(
      executeRuntimeReadPlan(plan, { ...context, organizationId: other }, runtime),
    ).rejects.toThrow("ontology_forbidden");
    await expect(
      executeRuntimeReadPlan(plan, context, { ...runtime, pipelineIds: null }),
    ).rejects.toThrow("ontology_forbidden");
    sql(`update public.ai_workbench_runs set scope='{}'::jsonb where id='${runtimeRun}'`);
    const allVisible = await executeRuntimeReadPlan(plan, context, {
      ...runtime,
      pipelineIds: null,
    });
    expect(allVisible.receipt.effectivePipelineIds).toBeNull();
    expect(allVisible.rows.some((row) => row.id === ids[2])).toBe(true);
    expect(allVisible.rows.some((row) => row.id === secondLead)).toBe(true);
    expect(allVisible.rows.some((row) => row.id === ids[0])).toBe(false);
    await expect(
      executeRuntimeReadPlan(plan, context, {
        ...runtime,
        pipelineIds: null,
        workbenchRunId: undefined,
      }),
    ).rejects.toThrow("ontology_forbidden");
    sql(
      `update public.ai_workbench_runs set scope=jsonb_build_object('pipelineId','${GOV_PIPELINE}') where id='${runtimeRun}'`,
    );
    await expect(
      executeRuntimeReadPlan(plan, context, { ...runtime, workbenchRunId: other }),
    ).rejects.toThrow("ontology_forbidden");
    await expect(
      executeRuntimeReadPlan(plan, context, { ...runtime, workbenchRunId: undefined }),
    ).rejects.toThrow("ontology_forbidden");
    sql(
      `update public.ai_workbench_runs set runtime_state=jsonb_build_object('versionId','${runtimeVersion}') where id='${runtimeRun}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `update public.ai_workbench_runs set runtime_state=jsonb_build_object('versionId','${draft}') where id='${runtimeRun}'; update public.api_tokens set expires_at=now()-interval '1 second' where id='${runtimeToken}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `update public.api_tokens set expires_at=now()+interval '1 hour' where id='${runtimeToken}'; update public.ai_workbench_runs set status='cancelled' where id='${runtimeRun}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `delete from public.ai_workbench_runs where id='${runtimeRun}'; delete from public.ai_agent_versions where id='${draft}'; update public.ai_agents set origin='user', builtin_key=null, model_binding_mode='organization_default' where id='${runtimeAgent}'`,
    );
  });
  it("revalidates a runtime token, published version and pipeline restriction", async () => {
    const context = {
      organizationId: GOV_ORG,
      role: "ai_operator",
      actor: {
        type: "ai_agent",
        id: runtimeRun,
        agent_id: runtimeAgent,
        role: "ai_operator",
        api_token_id: runtimeToken,
      },
      apiTokenId: runtimeToken,
      requestId: runtimeRun,
      supabase: {},
    } as Parameters<typeof executeRuntimeReadPlan>[1];
    const runtime = { versionId: runtimeVersion, runId: runtimeRun, pipelineIds: [GOV_PIPELINE] };
    sql(`update public.ai_agents set is_active=false where id='${runtimeAgent}'`);
    const result = await executeRuntimeReadPlan(plan, context, runtime);
    expect(result.receipt.partial).toBe(false);
    expect(result.receipt.effectivePipelineIds).toEqual([GOV_PIPELINE]);
    expect(result.rows.some((row) => row.id === ids[0])).toBe(false);
    expect(result.rows.some((row) => row.id === ids[2])).toBe(true);
    expect(result.rows.some((row) => row.id === secondLead)).toBe(false);
    const attemptedExpansion = await executeRuntimeReadPlan(plan, context, {
      ...runtime,
      pipelineIds: [GOV_PIPELINE, secondPipeline],
    });
    expect(attemptedExpansion.rows.some((row) => row.id === secondLead)).toBe(false);
    expect(
      (await executeRuntimeReadPlan(plan, context, { ...runtime, pipelineIds: [other] })).rows,
    ).toEqual([]);
    await expect(
      executeRuntimeReadPlan(plan, { ...context, organizationId: other }, runtime),
    ).rejects.toThrow("ontology_forbidden");
    await expect(
      executeRuntimeReadPlan(plan, context, { ...runtime, runId: other }),
    ).rejects.toThrow("ontology_forbidden");
    await expect(
      executeRuntimeReadPlan(plan, context, { ...runtime, versionId: other }),
    ).rejects.toThrow("ontology_forbidden");
    sql(`update public.api_tokens set scopes=scopes || '["mcp:tools:restricted"]'::jsonb where id='${runtimeToken}'`);
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `update public.api_tokens set scopes='["actor:ai_agent","role:ai_operator","agent_run:${runtimeRun}"]'::jsonb where id='${runtimeToken}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `update public.api_tokens set scopes='["mcp:read","actor:ai_agent","role:ai_operator","agent_run:${runtimeRun}"]'::jsonb, expires_at=now()-interval '1 second' where id='${runtimeToken}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
    sql(
      `update public.api_tokens set expires_at=now()+interval '1 hour', revoked_at=now() where id='${runtimeToken}'`,
    );
    await expect(executeRuntimeReadPlan(plan, context, runtime)).rejects.toThrow(
      "ontology_forbidden",
    );
  });
  it("works with the recommended restricted worker role without extra grants", async () => {
    const worker = new pg.Pool({
      connectionString: `postgresql://ontology_worker:synthetic@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
    });
    try {
      expect(
        (await executeWithIdentity(worker, plan, ident(GOV_MANAGER))).rows.some(
          (row) => row.id === ids[1],
        ),
      ).toBe(true);
      expect(
        (await executeWithIdentity(worker, plan, ident(GOV_AGENT_A))).rows.some(
          (row) => row.id === ids[1],
        ),
      ).toBe(false);
    } finally {
      await worker.end();
    }
  });
  it("cancels while waiting for a pool connection without leaking it", async () => {
    const limited = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 1,
    });
    const held = await limited.connect();
    const controller = new AbortController();
    try {
      const pending = executeWithIdentity(limited, plan, ident(GOV_MANAGER), controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("ontology_cancelled");
      held.release();
      const next = await limited.connect();
      next.release();
    } finally {
      await limited.end();
    }
  });
  it("cancels an in-flight locked query without returning SQL details", async () => {
    const c = await pool.connect();
    await c.query("begin");
    await c.query("lock table public.crm_leads in access exclusive mode");
    try {
      const controller = new AbortController();
      const pending = executeWithIdentity(pool, plan, ident(GOV_MANAGER), controller.signal);
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toThrow("ontology_cancelled");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
  it("installation role check runs as the actual worker and detects an incomplete grant", async () => {
    const script = readFileSync("supabase/ontology-role-check.sql", "utf8");
    const runCheck = () => sql(`set session authorization ontology_worker;\n${script}`).split("\n");
    expect(runCheck()).toContain("ok");
    await pool.query("revoke select (status) on public.crm_leads from ontology_reader");
    try {
      expect(runCheck()).toContain("failed");
    } finally {
      await pool.query("grant select (status) on public.crm_leads to ontology_reader");
    }
  });
  it("the ontology role has no CRM write privileges even outside a read-only transaction", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role ontology_reader");
      const rights = await c.query(
        "select has_table_privilege(current_user, 'public.crm_leads', 'UPDATE') as writable, has_any_column_privilege(current_user, 'public.crm_leads', 'UPDATE') as column_writable",
      );
      expect(rights.rows[0]).toEqual({ writable: false, column_writable: false });
      await expect(
        c.query("update public.crm_leads set value_cents=0 where id=$1", [ids[0]]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("the database rejects writes inside a read-only transaction", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin read only");
      await expect(
        c.query("update public.crm_leads set value_cents=0 where id=$1", [ids[0]]),
      ).rejects.toMatchObject({ code: "25006" });
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("matches an independently scoped SQL oracle for agent and manager", async () => {
    for (const user of [GOV_AGENT_A, GOV_MANAGER]) {
      const c = await pool.connect();
      try {
        await c.query("begin read only");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
        ]);
        const oracle = await c.query(
          "select id,status,value_cents,currency from crm_leads where organization_id=$1 and status='open' order by id limit 101",
          [GOV_ORG],
        );
        await c.query("commit");
        const got = await executeWithIdentity(pool, plan, ident(user));
        expect(got.rows).toEqual(oracle.rows.slice(0, 100));
        expect(got.receipt.rowCount).toBe(got.rows.length);
        expect(got.rows.some((row) => row.id === ids[1])).toBe(user === GOV_MANAGER);
        expect(got.rows.some((row) => row.id === ids[2] && row.value_cents === null)).toBe(true);
      } finally {
        c.release();
      }
    }
  });
  it("compares explicitly defined activity gap with an independent SQL oracle", async () => {
    sql(`insert into public.crm_lead_activities(organization_id,lead_id,type,source_module,performed_at)
      values ('${GOV_ORG}','${ids[0]}','appointment_completed','synthetic','2026-01-10T00:00:00Z')`);
    const criteria = {
      minimumValueCents: 100000,
      currency: "BRL",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-15T00:00:00Z",
      activityTypes: ["appointment_completed"],
    };
    const got = await executeWithIdentity(
      pool,
      planExplicitActivityGap(criteria),
      ident(GOV_MANAGER),
    );
    const oracle = await pool.query(
      `select l.id,l.status,l.value_cents,l.currency from public.crm_leads l
      where l.organization_id=$1 and l.status='open' and l.value_cents >= 100000 and l.currency='BRL'
      and not exists (select 1 from public.crm_lead_activities a where a.organization_id=l.organization_id
      and a.lead_id=l.id and a.type='appointment_completed' and a.performed_at >= '2026-01-01T00:00:00Z'
      and a.performed_at < '2026-01-15T00:00:00Z') order by l.id limit 101`,
      [GOV_ORG],
    );
    expect(got.rows).toEqual(oracle.rows.slice(0, 100));
    expect(got.receipt.partial).toBe(true);
    expect(got.rows.some((row) => row.id === secondLead)).toBe(true);
    expect(got.rows.some((row) => row.id === ids[1])).toBe(false);
    expect(
      got.rows.every(
        (row) => Object.keys(row).sort().join(",") === "currency,id,status,value_cents",
      ),
    ).toBe(true);
    expect(got.receipt.criteria).toEqual(criteria);
  });
  it("omits cross-tenant links and keeps a standalone task with a partial receipt", async () => {
    const taskPlan = planQuery("Quais tarefas sem prazo?")!;
    const got = await executeWithIdentity(pool, taskPlan, ident(GOV_MANAGER));
    expect(got.rows.some((row) => row.id === "a3300000-0000-4000-8000-000000000006")).toBe(false);
    expect(got.rows.some((row) => row.id === "a3300000-0000-4000-8000-000000000007")).toBe(true);
    expect(got.receipt.partial).toBe(true);
  });
  it("includes archived pipeline rows as declared in the receipt", async () => {
    await pool.query("update public.crm_pipelines set is_archived=true where id=$1", [
      secondPipeline,
    ]);
    try {
      const got = await executeWithIdentity(pool, plan, ident(GOV_MANAGER));
      expect(got.rows.some((row) => row.id === secondLead)).toBe(true);
      expect(got.receipt.scope).toContain("archive");
    } finally {
      await pool.query("update public.crm_pipelines set is_archived=false where id=$1", [
        secondPipeline,
      ]);
    }
  });
  it("marks row truncation rather than presenting a bounded page as complete", async () => {
    await pool.query(
      `insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      select md5('ontology-limit-' || n)::uuid,$1,$2,$3,'Synthetic bounded' from generate_series(1,105) n`,
      [GOV_ORG, GOV_PIPELINE, GOV_STAGE],
    );
    const got = await executeWithIdentity(pool, plan, ident(GOV_MANAGER));
    expect(got.rows).toHaveLength(100);
    expect(got.receipt.partial).toBe(true);
    expect(got.receipt.rowLimit).toBe(100);
  });
  it("rejects another tenant, malformed plan and revoked membership", async () => {
    await expect(executeWithIdentity(pool, plan, ident(GOV_AGENT_A, other))).rejects.toThrow(
      "ontology_forbidden",
    );
    await expect(
      executeWithIdentity(pool, { ...plan, sql: "delete from crm_leads" }, ident(GOV_AGENT_A)),
    ).rejects.toThrow();
    sql(
      `update public.user_organizations set revoked_at=now() where user_id='${GOV_AGENT_A}' and organization_id='${GOV_ORG}'`,
    );
    await expect(executeWithIdentity(pool, plan, ident(GOV_AGENT_A))).rejects.toThrow(
      "ontology_forbidden",
    );
  });
});
