import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeWithIdentity } from "@/lib/ontology/read-plan-internal";
import { planQuery } from "@/lib/ontology/query-plan";
import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
const app = new pg.Pool({
  connectionString: `postgresql://ontology_acl_worker:synthetic@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
const own = "a3300010-0000-4000-8000-000000000001";
const hidden = "a3300010-0000-4000-8000-000000000002";
const identity = (userId: string) => ({ userId, organizationId: GOV_ORG, aal: "aal1" as const });

beforeAll(() => {
  seedGov();
  // Reproduce the real Supabase ACL: no schema USAGE for the reader, while
  // auth functions retain their existing PUBLIC EXECUTE. Never grant auth here.
  sql(`create role ontology_acl_worker login password 'synthetic' bypassrls;
    grant usage on schema public to ontology_acl_worker;
    grant select, insert, update, delete on all tables in schema public to ontology_acl_worker;
    grant usage, select on all sequences in schema public to ontology_acl_worker;
    grant execute on all functions in schema public to ontology_acl_worker;
    grant ontology_reader to ontology_acl_worker;
    revoke usage on schema auth from public, ontology_reader;
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title,owner_user_id)
      values ('${own}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic own','${GOV_AGENT_A}'),
             ('${hidden}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic hidden','${GOV_AGENT_B}');
    insert into public.crm_tasks(id,organization_id,title,lead_id)
      values ('a3300010-0000-4000-8000-000000000003','${GOV_ORG}','Synthetic task','${own}');`);
});
afterAll(async () => {
  await app.end();
  await pool.end();
});

describe("ontology_reader with Supabase auth schema ACL", () => {
  it("retains real RLS visibility for approved templates without auth schema USAGE", async () => {
    const acl = await pool.query<{ usage: boolean; fn_exec: boolean }>(
      `select has_schema_privilege('ontology_reader','auth','USAGE') as usage,
       (select bool_and(has_function_privilege('ontology_reader',p.oid,'EXECUTE'))
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='auth' and p.proname in ('uid','jwt') and p.pronargs=0) as fn_exec`,
    );
    expect(acl.rows[0]).toEqual({ usage: false, fn_exec: true });
    const plan = planQuery("Quais negócios estão abertos?")!;
    const agent = await executeWithIdentity(app, plan, identity(GOV_AGENT_A));
    const manager = await executeWithIdentity(app, plan, identity(GOV_MANAGER));
    expect(agent.rows.some((row) => row.id === own)).toBe(true);
    expect(agent.rows.some((row) => row.id === hidden)).toBe(false);
    expect(manager.rows.some((row) => row.id === hidden)).toBe(true);
    const tasks = await executeWithIdentity(
      pool,
      planQuery("Quais tarefas sem prazo?")!,
      identity(GOV_AGENT_A),
    );
    expect(tasks.rows.some((row) => row.id === "a3300010-0000-4000-8000-000000000003")).toBe(true);
  });
  it("accepts the same ACL in the installation role check", () => {
    const script = readFileSync("supabase/ontology-role-check.sql", "utf8");
    expect(sql(`set session authorization ontology_acl_worker;\n${script}`).split("\n")).toContain(
      "ok",
    );
  });
  it("rejects a missing auth function execute privilege", () => {
    sql("revoke execute on function auth.uid() from public, ontology_reader");
    const script = readFileSync("supabase/ontology-role-check.sql", "utf8");
    expect(sql(`set session authorization ontology_acl_worker;\n${script}`).split("\n")).toContain(
      "failed",
    );
  });
});
