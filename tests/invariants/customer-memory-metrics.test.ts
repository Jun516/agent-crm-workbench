import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadCustomerMemoryMetrics } from "@/lib/ai/customer-memory/metrics";
import { saveCustomerMemory } from "@/lib/ai/integrations/mem0";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Run via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
let org: string, actor: string, contact: string, other: string, agent: string, memory: string;
beforeEach(async () => {
  org = randomUUID();
  actor = randomUUID();
  contact = randomUUID();
  other = randomUUID();
  agent = randomUUID();
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    actor,
    `${actor}@metrics.test.invalid`,
  ]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Metrics fixture','Metrics fixture')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
    [actor, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$3,'Metrics customer'),($2,$3,'Other customer')",
    [contact, other, org],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Metrics fixture','Synthetic')",
    [agent, org],
  );
  memory = (
    await saveCustomerMemory(pool, org, actor, {
      contact_id: contact,
      request_key: randomUUID(),
      category: "preference",
      body: "Synthetic confirmed preference",
      confirmed: true,
    })
  ).id;
});
afterAll(() => pool.end());
async function candidate(
  status: string,
  ageHours: number,
  decisionHours?: number,
  deleted = false,
  mergedInto?: string,
) {
  const id = randomUUID();
  await pool.query(
    `insert into ai_customer_memory_candidates(id,organization_id,contact_id,request_key,category,memory_type,body,risk_level,normalized_hash,source_kind,status,created_at,decided_at,confirmed_memory_id,decision_reason,rejected_until,deleted_at,merged_into)
    values($1::uuid,$2,$3,gen_random_uuid(),'preference','communication_preference','Synthetic suggestion','medium',replace($1::text,'-','')||replace($1::text,'-',''),'explicit',$4,now()-$5::double precision*interval '1 hour',case when $6::double precision is not null then now()-($5-$6)*interval '1 hour' else null end,
    case when $4='confirmed' then $7::uuid else null end,case when $4='rejected' then 'Fixture rejection' else null end,case when $4='rejected' then now()+interval '1 day' else null end,case when $8 then now() else null end,$9)`,
    [
      id,
      org,
      contact,
      status,
      ageHours,
      decisionHours ?? null,
      memory,
      deleted,
      mergedInto ?? null,
    ],
  );
  return id;
}
async function run(parent?: string) {
  const id = randomUUID();
  await pool.query(
    "insert into ai_workbench_runs(id,organization_id,agent_id,task,mode,scope,status,parent_run_id,run_kind,specialist_key,collaboration_key) values($1,$2,$3,'Metrics fixture','inspect',$4,'completed',$5,case when $5::uuid is null then 'root' else 'specialist' end,case when $5::uuid is null then null else 'metrics' end,case when $5::uuid is null then null else 'metrics-fixture' end)",
    [id, org, agent, { contactId: contact }, parent ?? null],
  );
  return id;
}
async function receipt(runId: string | null, corrected = false, draftId?: string) {
  const id = randomUUID();
  const draft = draftId
    ? (
        await pool.query(
          "select conversation_id,generation_token from ai_reply_drafts where id=$1",
          [draftId],
        )
      ).rows[0]
    : null;
  await pool.query(
    `insert into ai_customer_memory_recalls(id,organization_id,contact_id,run_id,conversation_id,draft_id,draft_generation_token,purpose,call_outcome,status,provider_status,coverage,returned_count,business_coverage,injected_at)
    values($1,$2,$3,$4,$5,$6,$7,'metrics_fixture','success','ok','disabled','complete',1,'complete',now())`,
    [
      id,
      org,
      contact,
      runId,
      draft?.conversation_id ?? null,
      draftId ?? null,
      draft?.generation_token ?? null,
    ],
  );
  await pool.query(
    `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,recall_id,memory_id,memory_revision,policy_revision,memory_type,risk_level,locked,needs_review,confirmed_at,corrected_at)
    select $1,$2,$3,$4,id,content_hash,policy_revision,memory_type,risk_level,locked,needs_review,confirmed_at,case when $6 then now() else null end from ai_customer_memories where id=$5`,
    [org, contact, runId, id, memory, corrected],
  );
}
describe("manager customer-memory governance metrics", () => {
  it("uses explicit decision denominators, real median latency, stale backlog and conflict waiting times", async () => {
    await candidate("confirmed", 10, 1);
    await candidate("confirmed", 10, 3);
    await candidate("rejected", 10, 1);
    const retained = await candidate("pending", 24 * 8);
    await candidate("pending", 1);
    await candidate("pending", 24 * 9, undefined, true);
    await candidate("merged", 2, 1, false, retained);
    await pool.query(
      `insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,conflict_key,kind,status,created_at,resolved_at)
      values($1,$2,$3,'open-old','l0_l1','open',now()-interval '8 hours',null),($1,$2,$3,'open-new','l0_l1','open',now()-interval '2 hours',null),($1,$2,$3,'resolved','l0_l1','resolved',now()-interval '10 hours',now()-interval '6 hours')`,
      [org, contact, memory],
    );
    const metrics = await loadCustomerMemoryMetrics(pool, org, actor, contact);
    expect(metrics).toMatchObject({
      confirmed_count: 2,
      rejected_count: 1,
      decided_count: 3,
      confirmation_latency_sample_count: 2,
      median_confirmation_seconds: 7200,
      pending_count: 2,
      pending_over_7d_count: 1,
      open_conflict_count: 2,
      median_resolved_conflict_seconds: 14400,
    });
    expect(metrics.confirmation_rate).toBeCloseTo(2 / 3);
    expect(metrics.rejection_rate).toBeCloseTo(1 / 3);
    expect(metrics.oldest_open_conflict_seconds!).toBeGreaterThanOrEqual(8 * 3600);
    expect(metrics.median_open_conflict_seconds!).toBeLessThan(5 * 3600 + 30);
    expect((await loadCustomerMemoryMetrics(pool, org, actor, other)).decided_count).toBe(0);
  });
  it("counts distinct root reports and draft IDs instead of inflating rates with repeated requests", async () => {
    const first = await run(),
      second = await run(),
      child = await run(first);
    await receipt(first);
    await receipt(first, true);
    await receipt(child);
    await receipt(second);
    const channel = randomUUID(),
      conversation = randomUUID(),
      version = randomUUID(),
      draft = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
      [channel, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [conversation, org, contact, channel],
    );
    await pool.query(
      "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,channel_session_id) values($1,$2,$3,99,'Fixture','fixture','fixture','draft',$4)",
      [version, org, agent, channel],
    );
    await pool.query(
      "insert into ai_reply_drafts(id,organization_id,contact_id,conversation_id,agent_id,agent_version_id,channel_session_id,service_boundary,context_revision,operation_revision) values($1,$2,$3,$4,$5,$6,$7,'{}',1,1)",
      [draft, org, contact, conversation, agent, version, channel],
    );
    await receipt(null, false, draft);
    await receipt(null, true, draft);
    const metrics = await loadCustomerMemoryMetrics(pool, org, actor, contact);
    expect(metrics).toMatchObject({
      used_report_count: 2,
      corrected_report_count: 1,
      report_correction_rate: 0.5,
      used_draft_count: 1,
      corrected_draft_count: 1,
      draft_correction_rate: 1,
    });
  });
  it("returns null for missing samples and excludes legacy unproven usage from report denominators", async () => {
    const runId = await run();
    await pool.query(
      `insert into ai_customer_memory_usage(organization_id,contact_id,run_id,memory_id,memory_revision,policy_revision)
      select $1,$2,$3,id,content_hash,policy_revision from ai_customer_memories where id=$4`,
      [org, contact, runId, memory],
    );
    expect(await loadCustomerMemoryMetrics(pool, org, actor, contact)).toMatchObject({
      decided_count: 0,
      confirmation_rate: null,
      rejection_rate: null,
      median_confirmation_seconds: null,
      open_conflict_count: 0,
      oldest_open_conflict_seconds: null,
      used_report_count: 0,
      report_correction_rate: null,
      used_draft_count: 0,
      draft_correction_rate: null,
    });
  });
  it("rechecks manager authority, tenant/contact boundaries, revocation and privacy", async () => {
    await pool.query(
      "update user_organizations set role='agent' where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    await expect(loadCustomerMemoryMetrics(pool, org, actor, contact)).rejects.toThrow(
      "manager_required",
    );
    await pool.query(
      "update user_organizations set role='manager',revoked_at=now() where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    await expect(loadCustomerMemoryMetrics(pool, org, actor, contact)).rejects.toThrow("forbidden");
    await expect(loadCustomerMemoryMetrics(pool, randomUUID(), actor, contact)).rejects.toThrow(
      "contact_unavailable",
    );
    await pool.query(
      "update user_organizations set revoked_at=null where organization_id=$1 and user_id=$2",
      [org, actor],
    );
    await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [
      org,
      contact,
    ]);
    await expect(loadCustomerMemoryMetrics(pool, org, actor, contact)).rejects.toThrow(
      "contact_unavailable",
    );
  });
});
