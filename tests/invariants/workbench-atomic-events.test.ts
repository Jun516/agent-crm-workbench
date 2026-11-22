import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";
import { appendWorkbenchEventTx } from "@/lib/ai/agents/workbench-transaction-events";

const agent = "a4130000-0000-4000-8000-000000000001";
const lead = "a4130000-0000-4000-8000-000000000002";
const mission = "a4130000-0000-4000-8000-000000000003";
const run = "a4130000-0000-4000-8000-000000000004";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 20,
});

beforeAll(() => {
  seedGov();
  sql(`insert into public.ai_agents(id,organization_id,name,system_prompt,kind) values ('${agent}','${GOV_ORG}','Synthetic atomic event','Synthetic','mcp_agent');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title) values ('${lead}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Synthetic atomic lead');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria,status) values ('${mission}','${GOV_ORG}','${lead}','${GOV_MANAGER}','Synthetic','Synthetic','running');
    insert into public.ai_workbench_runs(id,organization_id,agent_id,actor_user_id,mission_id,task,mode,status) values ('${run}','${GOV_ORG}','${agent}','${GOV_MANAGER}','${mission}','Synthetic','inspect','running');`);
});
afterAll(async () => {
  await pool.query("delete from public.ai_workbench_runs where id=$1", [run]);
  await pool.query("delete from public.ai_missions where id=$1", [mission]);
  await pool.query("delete from public.crm_leads where id=$1", [lead]);
  await pool.query("delete from public.ai_agents where id=$1", [agent]);
  await pool.end();
});

it("serializes concurrent mixed events with a Mission cancellation across connections", async () => {
  const events = Array.from({ length: 16 }, (_, index) =>
    pool.query<{ sequence: number }>(
      "select public.fn_append_workbench_event($1,$2,$3,$4::jsonb) as sequence",
      [
        GOV_ORG,
        run,
        index === 15 ? "run_completed" : "tool_started",
        JSON.stringify({ tool: index % 2 ? "ontology_query" : "crm_list_leads" }),
      ],
    ),
  );
  const cancel = pool.query<{ result: string }>(
    "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
    [GOV_ORG, mission, GOV_MANAGER, "synthetic"],
  );
  const [written, cancelled] = await Promise.all([Promise.all(events), cancel]);
  expect(cancelled.rows[0]?.result).toBe("cancelled");
  expect(new Set(written.map((item) => item.rows[0]?.sequence)).size).toBe(16);
  const persisted = await pool.query<{ sequence: number; event_type: string }>(
    "select sequence,event_type from public.ai_agent_run_events where organization_id=$1 and run_id=$2 order by sequence",
    [GOV_ORG, run],
  );
  expect(persisted.rows.map((item) => item.sequence)).toEqual(
    Array.from({ length: 17 }, (_, index) => index + 1),
  );
  expect(persisted.rows.filter((item) => item.event_type === "run_cancelled")).toHaveLength(1);
  await expect(
    pool.query("select public.fn_append_workbench_event($1,$2,$3,$4::jsonb)", [
      "a4130000-0000-4000-8000-000000000099",
      run,
      "tool_started",
      "{}",
    ]),
  ).rejects.toThrow("workbench_run_not_found");
  const next = await pool.query<{ sequence: number }>(
    "select public.fn_append_workbench_event($1,$2,$3,$4::jsonb) as sequence",
    [GOV_ORG, run, "tool_started", "{}"],
  );
  expect(next.rows[0]?.sequence).toBe(18);
});

it("does not grant append authority to anon or authenticated", async () => {
  const result = await pool.query<{
    anon: boolean;
    authenticated: boolean;
    service: boolean;
  }>(`select
    has_function_privilege('anon','public.fn_append_workbench_event(uuid,uuid,text,jsonb)','execute') anon,
    has_function_privilege('authenticated','public.fn_append_workbench_event(uuid,uuid,text,jsonb)','execute') authenticated,
    has_function_privilege('service_role','public.fn_append_workbench_event(uuid,uuid,text,jsonb)','execute') service`);
  expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
});

it("keeps the approval transaction event and concurrent RPC events contiguous", async () => {
  const client = await pool.connect();
  let pending: Promise<pg.QueryResult>[] = [];
  try {
    await client.query("begin");
    await client.query(
      "select id from public.ai_workbench_runs where organization_id=$1 and id=$2 for update",
      [GOV_ORG, run],
    );
    pending = Array.from({ length: 4 }, () =>
      pool.query("select public.fn_append_workbench_event($1,$2,$3,$4::jsonb)", [
        GOV_ORG,
        run,
        "tool_started",
        JSON.stringify({ tool: "ontology_query" }),
      ]),
    );
    await appendWorkbenchEventTx(client, GOV_ORG, run, "human_confirmation_received", {
      decision: "approve",
      actorUserId: GOV_MANAGER,
      apiKey: "must-not-persist",
    });
    await client.query("commit");
    await Promise.all(pending);
    const rows = await pool.query<{ sequence: number; event_type: string; payload: unknown }>(
      "select sequence,event_type,payload from public.ai_agent_run_events where organization_id=$1 and run_id=$2 order by sequence",
      [GOV_ORG, run],
    );
    expect(rows.rows.map((item) => item.sequence)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 1),
    );
    expect(
      rows.rows.filter((item) => item.event_type === "human_confirmation_received"),
    ).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain("must-not-persist");
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await Promise.allSettled(pending);
  }
});
