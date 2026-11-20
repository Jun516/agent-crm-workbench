/** Real browser/SQL acceptance. Model extraction has a separate gateway-fixture DB suite. */
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { mkdir } from "node:fs/promises";
import pg from "pg";
import { test, expect } from "@playwright/test";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { proposeCustomerMemory } from "@/lib/ai/customer-memory/candidates";
import { createCustomerMemoryCall } from "@/lib/ai/customer-memory/consumption";
import { saveCustomerMemory } from "@/lib/ai/integrations/mem0";

test.describe.configure({ timeout: 180_000 });
const evidence = ".superpowers/evidence/customer-memory-loop";
let pool: pg.Pool,
  org: string,
  actor: string,
  contact: string,
  channel: string,
  conversation: string,
  message: string;
let loginEmail: string, loginPassword: string;
const ownsBootstrap = Boolean(process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD);
test.beforeAll(async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname))
    throw new Error("Memory browser acceptance requires the isolated local SUPABASE_DB_URL.");
  pool = new pg.Pool({ connectionString, max: 4 });
  const creds = ownsBootstrap ? null : lerCreds();
  loginEmail = process.env.OWNER_EMAIL ?? creds!.users.admin!.email;
  loginPassword = process.env.OWNER_PASSWORD ?? creds!.password;
  const member = (
    await pool.query(
      `select u.id actor,o.id org from auth.users u join user_organizations m on m.user_id=u.id
    join organizations o on o.id=m.organization_id where u.email=$1 and m.revoked_at is null and m.accepted_at is not null
    and o.display_name=$2 limit 1`,
      [loginEmail, ownsBootstrap ? process.env.OWNER_ORG_NAME : "E2E Test Org"],
    )
  ).rows[0];
  if (!member) throw new Error("Bootstrap/fixture owner membership is missing.");
  org = member.org;
  actor = member.actor;
  // Fixture prerequisite only; this spec does not claim onboarding acceptance.
  if (ownsBootstrap)
    await pool.query(
      "update organizations set onboarded_at=coalesce(onboarded_at,now()) where id=$1",
      [org],
    );
  contact = randomUUID();
  channel = randomUUID();
  conversation = randomUUID();
  message = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Memory acceptance · synthetic customer')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
    [channel, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,assignee_kind,assigned_at,service_revision) values($1,$2,$3,$4,$5,'user',now(),1)",
    [conversation, org, contact, channel, actor],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,body,service_revision) values($1,$2,$3,$4,$5,'text','inbound','Please use email for invoices. Never call after 18:00.',1)",
    [message, org, contact, conversation, channel],
  );
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await pool?.end();
});

test("report footer → rewrite/confirm/reject → contact lock/unlock/retire", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (ownsBootstrap) {
    await page.goto("/login");
    await page.locator("#email").fill(loginEmail);
    await page.locator("#password").fill(loginPassword);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
  } else await loginComoAdmin(page, lerCreds());
  await page.goto("/app/ai/workbench");
  await expect(page.getByLabel("内置 Agent", { exact: true })).toBeVisible();
  const agent = await page.getByLabel("内置 Agent", { exact: true }).inputValue();
  const run = randomUUID(),
    task = `Memory acceptance report ${run.slice(0, 8)}`;
  await pool.query(
    "insert into ai_workbench_runs(id,organization_id,agent_id,actor_user_id,task,mode,scope,status,final_text,completed_at) values($1,$2,$3,$4,$5,'inspect',$6,'completed','验收报告（合成数据）：请核对客户偏好与原文证据。',now())",
    [run, org, agent, actor, task, { contactId: contact, conversationId: conversation }],
  );
  const proposal = await proposeCustomerMemory(
    pool,
    org,
    {
      contact_id: contact,
      request_key: randomUUID(),
      category: "communication_context",
      memory_type: "communication_preference",
      body: "Prefers email for invoices",
      evidence: [{ message_id: message, excerpt: "Please use email for invoices." }],
      conflicts_with: [],
    },
    { kind: "workbench_complete", actor: null, runId: run, confidence: 0.92 },
  );
  const reject = await proposeCustomerMemory(
    pool,
    org,
    {
      contact_id: contact,
      request_key: randomUUID(),
      category: "communication_context",
      memory_type: "constraint",
      body: "No calls after 18:00",
      evidence: [{ message_id: message, excerpt: "Never call after 18:00." }],
      conflicts_with: [],
    },
    { kind: "workbench_complete", actor: null, runId: run, confidence: 0.87 },
  );
  await page.reload();
  await page.getByRole("button", { name: /^运行详情/ }).click();
  await page.getByRole("button", { name: new RegExp(task) }).click();
  const footer = page
    .getByRole("region", { name: "Agent 对话" })
    .getByRole("region", { name: "建议确认的记忆" });
  // A named section is a region in the accessibility tree.
  await expect(footer).toBeVisible();
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.getByText("“Please use email for invoices.”")).toBeVisible();
  await expect(footer.getByRole("link", { name: "查看来源会话" }).first()).toHaveAttribute(
    "href",
    `/app/inbox?id=${conversation}`,
  );
  await expect(footer.getByRole("button", { name: "同意并确认" }).first()).toBeVisible();
  await page.screenshot({ path: `${evidence}/report-candidates.png`, fullPage: true });
  const card = footer.getByRole("article", { name: "候选：Prefers email for invoices" });
  await card.getByRole("button", { name: "改写", exact: true }).click();
  await card.getByRole("textbox", { name: "改写记忆内容" }).fill("Use email for invoices only.");
  await card.getByRole("button", { name: "改写后确认" }).click();
  await expect(card).toHaveCount(0);
  const confirmed = (
    await pool.query(
      "select id,body,confirmed_by from ai_customer_memories where organization_id=$1 and contact_id=$2 and deleted_at is null",
      [org, contact],
    )
  ).rows;
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]).toMatchObject({ body: "Use email for invoices only.", confirmed_by: actor });
  expect(
    (
      await pool.query(
        "select confirmed_memory_id from ai_customer_memory_candidates where id=$1",
        [proposal.id],
      )
    ).rows[0].confirmed_memory_id,
  ).toBe(confirmed[0].id);
  const rejectCard = footer.getByRole("article", { name: "候选：No calls after 18:00" });
  await rejectCard.getByRole("button", { name: "驳回", exact: true }).click();
  await rejectCard
    .getByRole("textbox", { name: "驳回原因" })
    .fill("Needs clarification about customer timezone");
  await rejectCard.getByLabel("暂停同类建议至（本地时区）").fill("2099-01-01T12:00");
  await rejectCard.getByRole("button", { name: "确认驳回" }).click();
  await expect(rejectCard).toHaveCount(0);
  expect(
    (
      await pool.query(
        "select status,decision_reason from ai_customer_memory_candidates where id=$1",
        [reject.id],
      )
    ).rows[0],
  ).toEqual({ status: "rejected", decision_reason: "Needs clarification about customer timezone" });
  // Synthetic runtime acknowledgement seeds the receipt for UI acceptance.
  // Actual native Pi request proofs have separate real-DB invariant coverage.
  await pool.query("update ai_workbench_runs set status='running' where id=$1", [run]);
  const call = createCustomerMemoryCall(
    pool,
    {
      tenantId: org,
      workbenchRunId: run,
      purpose: "agent_turn",
      messages: [{ role: "user", content: "Review invoice communication" }],
    },
    { contactId: contact, conversationId: conversation, task: "Review invoice communication" },
  );
  const requestMessages = await call.input.transformContext!([
    { role: "user", content: "Review invoice communication" },
  ]);
  const probe = call.input.contextProbes!(requestMessages)[0]!;
  await call.input.onEvent!({ type: "model_context_consumed", data: { probeId: probe.id } });
  await call.finish(null, "success");
  await pool.query("update ai_workbench_runs set status='completed' where id=$1", [run]);
  const usagePanel = page.getByRole("region", { name: "本次使用的客户记忆", exact: true });
  await usagePanel.getByRole("button", { name: "刷新使用记录" }).click();
  await expect(usagePanel.getByText("Use email for invoices only.", { exact: true })).toBeVisible();
  await expect(usagePanel.getByRole("link", { name: "查看证据会话" })).toHaveAttribute(
    "href",
    `/app/inbox?id=${conversation}`,
  );
  await usagePanel.getByRole("button", { name: "纠正这次记忆使用" }).click();
  await usagePanel
    .getByRole("textbox", { name: "记忆使用纠正原因" })
    .fill("Synthetic feedback: confirm the customer's current invoice channel.");
  await usagePanel.getByRole("button", { name: "提交纠正并待复核" }).click();
  await expect(usagePanel.getByText(/已提交纠正：Synthetic feedback/)).toBeVisible();
  expect(
    (
      await pool.query(
        "select needs_review,review_reason,body from ai_customer_memories where id=$1",
        [confirmed[0].id],
      )
    ).rows[0],
  ).toEqual({
    needs_review: true,
    review_reason: "usage_correction",
    body: "Use email for invoices only.",
  });
  await usagePanel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/report-usage-correction.png`, fullPage: true });
  await page.goto(`/app/contacts/${contact}`);
  const panel = page.getByRole("region", { name: "客户记忆", exact: true });
  await expect(panel.getByText("Use email for invoices only.", { exact: true })).toBeVisible();
  const metrics = panel.getByRole("region", { name: "记忆治理指标" });
  await expect(
    metrics
      .locator("dl > div")
      .filter({ hasText: "候选确认率" })
      .getByText("50.0%（1/2 个已决定候选）"),
  ).toBeVisible();
  await expect(metrics.getByText("100.0%（1/1 份有记忆回执的报告）")).toBeVisible();
  await metrics.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/manager-metrics.png` });
  await panel.getByRole("combobox", { name: /^记忆类型/ }).selectOption("constraint");
  await panel
    .getByRole("textbox", { name: "记忆内容", exact: true })
    .fill("Do not mention competitors.");
  await panel.getByRole("checkbox", { name: "锁定核心约束，修改前须显式解锁" }).check();
  await panel.getByRole("button", { name: "确认并保存" }).click();
  await expect(panel.getByText("已确认并保存。", { exact: true })).toBeVisible();
  const locked = panel
    .getByRole("article")
    .filter({ has: page.getByText("Do not mention competitors.", { exact: true }) });
  await expect(locked.getByRole("button", { name: "停用此记忆" })).toBeDisabled();
  const ops = panel.getByRole("button", { name: "同步与清理状态（运维）" });
  await expect(ops).toHaveAttribute("aria-expanded", "false");
  const operations = panel.locator("[role=region]").filter({ hasText: "SQL 是确认记忆真源" });
  expect(await operations.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(2);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/contact-locked.png`, fullPage: true });
  await locked.getByRole("button", { name: "显式解锁" }).click();
  await expect(locked.getByRole("button", { name: "锁定记忆" })).toBeVisible();
  await locked.getByRole("button", { name: "停用此记忆" }).click();
  await locked
    .getByRole("textbox", { name: "停用原因" })
    .fill("Customer explicitly changed this preference");
  await locked.getByRole("button", { name: "提交停用" }).click();
  await expect(panel.getByText("Do not mention competitors.", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Do not mention competitors.", { exact: true })).toHaveCount(0);
  expect(
    (
      await pool.query(
        "select body,attribute_key,deleted_at from ai_customer_memories where organization_id=$1 and contact_id=$2 order by created_at desc limit 1",
        [org, contact],
      )
    ).rows[0],
  ).toMatchObject({ body: "", attribute_key: null, deleted_at: expect.any(Date) });
  await expect(page.getByText("Use email for invoices only.", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: `${evidence}/contact-after-retire.png`, fullPage: true });
});

test("agent source RLS skips 120 private suggestions and loads more than 100 confirmed records", async ({
  page,
}) => {
  const email = `memory28-agent-${randomUUID()}@example.invalid`,
    password = randomUUID() + "Aa!";
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (user.error || !user.data.user)
    throw new Error("Cannot create isolated synthetic agent fixture.");
  const agentUser = user.data.user.id,
    subject = randomUUID(),
    privateChannel = randomUUID(),
    publicChannel = randomUUID(),
    privateConversation = randomUUID(),
    publicConversation = randomUUID();
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())",
    [agentUser, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Private queue acceptance · synthetic')",
    [subject, org],
  );
  for (const [ch, conv, owner] of [
    [privateChannel, privateConversation, actor],
    [publicChannel, publicConversation, agentUser],
  ]) {
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,decode('00','hex'))",
      [ch, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,assignee_kind,assigned_at) values($1,$2,$3,$4,$5,'user',now())",
      [conv, org, subject, ch, owner],
    );
  }
  for (const [count, source, body, risk, type] of [
    [120, privateConversation, "PRIVATE_CANDIDATE_CANARY", "high", "constraint"],
    [5, publicConversation, "Visible shared preference", "medium", "communication_preference"],
  ] as const) {
    await pool.query(
      `with inserted as(insert into ai_customer_memory_candidates(organization_id,contact_id,request_key,category,memory_type,body,risk_level,normalized_hash,source_kind,created_at)
      select $1,$2,gen_random_uuid(),'preference',$7,$4||' '||n::text,$5,md5(n::text||$4)||md5(n::text||$4),'checkpoint','2026-11-10T00:00:00.123456Z' from generate_series(1,$6::int) n returning id)
      insert into ai_customer_memory_evidence(organization_id,contact_id,candidate_id,conversation_id,excerpt,observed_at) select $1,$2,id,$3,'Synthetic shared evidence',now() from inserted`,
      [org, subject, source, body, risk, count, type],
    );
  }
  const records = Array.from({ length: 105 }, (_, i) => {
    const body = `Shared confirmed preference ${i + 1}`;
    return {
      id: randomUUID(),
      body,
      content_hash: createHash("sha256").update(body).digest("hex"),
    };
  });
  await pool.query(
    `insert into ai_customer_memories(id,organization_id,contact_id,request_key,category,body,content_hash,subject_key,confirmed_by,memory_type,risk_level,created_at,confirmed_at)
    select x.id,$1,$2,gen_random_uuid(),'preference',x.body,x.content_hash,repeat('a',64),$3,'communication_preference','medium','2026-11-11T00:00:00.123456Z','2026-11-11T00:00:00.123456Z'
    from jsonb_to_recordset($4::jsonb) x(id uuid,body text,content_hash text)`,
    [org, subject, actor, JSON.stringify(records)],
  );
  const last = (
    await pool.query(
      "select body from ai_customer_memories where organization_id=$1 and contact_id=$2 order by created_at desc,id desc offset 104 limit 1",
      [org, subject],
    )
  ).rows[0].body as string;
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("button[type=submit]").click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
  expect(
    (await page.request.get(`/api/v1/ai/customer-memory/metrics?contact_id=${subject}`)).status(),
  ).toBe(403);
  const firstStatus = await page.request.get(`/api/v1/ai/customer-memory?contact_id=${subject}`);
  expect(firstStatus.status()).toBe(200);
  const statusCursor = (await firstStatus.json()).meta.cursor as string;
  expect(statusCursor).toBeTruthy();
  expect(
    (
      await page.request.get(
        `/api/v1/ai/customer-memory?contact_id=${subject}&cursor=${statusCursor}A`,
      )
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.get(
        `/api/v1/ai/customer-memory?contact_id=${contact}&cursor=${statusCursor}`,
      )
    ).status(),
  ).toBe(400);
  const queueResponse = await page.request.get(
    `/api/v1/ai/customer-memory/candidates?contact_id=${subject}`,
  );
  expect(queueResponse.status()).toBe(200);
  const queue = await queueResponse.json();
  expect(queue.data).toHaveLength(5);
  expect(JSON.stringify(queue)).not.toContain("PRIVATE_CANDIDATE_CANARY");
  expect(JSON.stringify(queue)).not.toContain(privateConversation);
  const privateJob = randomUUID(),
    publicJob = randomUUID();
  for (const [id, conv] of [
    [privateJob, privateConversation],
    [publicJob, publicConversation],
  ])
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,last_error,payload) values($1,$2,$3,'customer_memory_extract','done','PRIVATE_ACTIVITY_ERROR_CANARY',$4)",
      [
        id,
        org,
        subject,
        {
          source: {
            contact_id: subject,
            source_kind: "conversation_close",
            conversation_id: conv,
            service_revision: 1,
            until_at: new Date().toISOString(),
            source_run_id: null,
            run_after: new Date().toISOString(),
          },
          memory_result: { status: "unavailable", reason: "model_not_configured" },
        },
      ],
    );
  const activityResponse = await page.request.get(
    `/api/v1/ai/customer-memory/activity?contact_id=${subject}`,
  );
  expect(activityResponse.status()).toBe(200);
  const activity = await activityResponse.json();
  expect(activity.data.map((r: { id: string }) => r.id)).toContain(publicJob);
  expect(JSON.stringify(activity)).not.toMatch(
    new RegExp(`${privateJob}|${privateConversation}|PRIVATE_ACTIVITY_ERROR_CANARY`),
  );
  expect(
    (
      await page.request.post("/api/v1/ai/customer-memory/activity", {
        data: {
          contact_id: subject,
          job_id: privateJob,
          revision: "a".repeat(64),
          request_key: randomUUID(),
        },
      })
    ).status(),
  ).toBe(404);
  await page.goto(`/app/contacts/${subject}`);
  const panel = page.getByRole("region", { name: "客户记忆", exact: true });
  await expect(panel.getByText(/^Shared confirmed preference /)).toHaveCount(100);
  await expect(panel.getByText(last, { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "加载更多记忆记录" }).click();
  await expect(panel.getByText(/^Shared confirmed preference /)).toHaveCount(105);
  await expect(panel.getByText(last, { exact: true })).toBeVisible();
  await expect(panel.getByText(/PRIVATE_CANDIDATE_CANARY/)).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "记忆治理指标" })).toHaveCount(0);
  await panel.getByText(last, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/agent-paginated-memory.png` });
  const publicView = activity.data.find((r: { id: string }) => r.id === publicJob);
  const retry = {
    contact_id: subject,
    job_id: publicJob,
    revision: publicView.revision,
    request_key: randomUUID(),
  };
  expect(
    (await page.request.post("/api/v1/ai/customer-memory/activity", { data: retry })).status(),
  ).toBe(200);
  await pool.query(
    "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
    [org, agentUser],
  );
  try {
    expect(
      (await page.request.post("/api/v1/ai/customer-memory/activity", { data: retry })).status(),
    ).toBe(403);
  } finally {
    await pool.query(
      "update user_organizations set revoked_at=null where organization_id=$1 and user_id=$2",
      [org, agentUser],
    );
  }
});

test("report and contact explain unavailable extraction, link configuration and queue one audited retry", async ({
  page,
}) => {
  // HTTP self-hosts have getRandomValues but no secure-context randomUUID API.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (ownsBootstrap) {
    await page.goto("/login");
    await page.locator("#email").fill(loginEmail);
    await page.locator("#password").fill(loginPassword);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
  } else await loginComoAdmin(page, lerCreds());
  await page.goto("/app/ai/workbench");
  expect(await page.evaluate(() => typeof globalThis.crypto.randomUUID)).toBe("undefined");
  const agent = await page.getByLabel("内置 Agent", { exact: true }).inputValue(),
    run = randomUUID(),
    job = randomUUID(),
    task = `Memory background acceptance ${run.slice(0, 8)}`;
  await pool.query(
    "insert into ai_workbench_runs(id,organization_id,agent_id,actor_user_id,task,mode,scope,status,final_text,completed_at) values($1,$2,$3,$4,$5,'inspect',$6,'completed','后台整理验收报告（合成数据）：请核对整理状态。',now())",
    [run, org, agent, actor, task, { contactId: contact, conversationId: conversation }],
  );
  // Synthetic unavailable worker receipt; no external model or message is sent by this browser scenario.
  const source = {
    contact_id: contact,
    source_kind: "workbench_complete",
    conversation_id: conversation,
    service_revision: 1,
    until_at: new Date().toISOString(),
    source_run_id: run,
    run_after: new Date().toISOString(),
  };
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status,payload,last_error) values($1,$2,$3,'customer_memory_extract','done',$4,'PRIVATE_ACTIVITY_ERROR_CANARY')",
    [
      job,
      org,
      contact,
      {
        source,
        memory_result: { status: "unavailable", reason: "model_not_configured" },
        private_canary: "PRIVATE_ACTIVITY_PAYLOAD_CANARY",
      },
    ],
  );
  await page.reload();
  await page.getByRole("button", { name: /^运行详情/ }).click();
  await page.getByRole("button", { name: new RegExp(task) }).click();
  const footer = page
    .getByRole("region", { name: "Agent 对话" })
    .getByRole("region", { name: "建议确认的记忆" });
  const status = footer.getByRole("region", { name: "后台记忆整理" });
  await expect(status.getByText(/自动整理需要处理/)).toBeVisible();
  await status.getByRole("button", { name: "查看需要处理的整理记录" }).click();
  await expect(status.getByText(/缺少可用模型，尚未完成提炼或检查/)).toBeVisible();
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/report-background-unavailable.png` });
  await status.getByRole("link", { name: "模型设置" }).click();
  await expect(page).toHaveURL(/\/app\/ai\/providers/);
  await page.goto(`/app/contacts/${contact}`);
  const contactStatus = page.getByRole("region", { name: "后台记忆整理" });
  await contactStatus.getByRole("button", { name: "查看需要处理的整理记录" }).click();
  await expect(contactStatus.getByText(/缺少可用模型/)).toBeVisible();
  const before = (
    await pool.query(
      "select count(*)::int n from ai_customer_memories where organization_id=$1 and contact_id=$2",
      [org, contact],
    )
  ).rows[0].n;
  const posted = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().includes("/api/v1/ai/customer-memory/activity"),
  );
  await contactStatus.getByRole("button", { name: "重试整理" }).click();
  const request = (await posted).postDataJSON();
  await expect(contactStatus.getByText(/等待后台整理/)).toBeVisible();
  expect(
    (await page.request.post("/api/v1/ai/customer-memory/activity", { data: request })).status(),
  ).toBe(200);
  const actual = (
    await pool.query("select status,payload from job_queue where organization_id=$1 and id=$2", [
      org,
      job,
    ])
  ).rows[0];
  expect(actual.status).toBe("pending");
  expect(actual.payload.source).toEqual(source);
  expect(actual.payload.manual_retry).toMatchObject({ actor_user_id: actor, count: 1 });
  await expect
    .poll(async () =>
      Number(
        (
          await pool.query(
            "select count(*)::int n from api_audit_log where organization_id=$1 and actor_user_id=$2 and resource_id=$3 and action='ai.customer_memory_job_retried'",
            [org, actor, job],
          )
        ).rows[0].n,
      ),
    )
    .toBe(1);
  expect(
    (
      await pool.query(
        "select count(*)::int n from ai_customer_memories where organization_id=$1 and contact_id=$2",
        [org, contact],
      )
    ).rows[0].n,
  ).toBe(before);
  const current = await page.request.get(
    `/api/v1/ai/customer-memory/activity?contact_id=${contact}`,
  );
  expect(JSON.stringify(await current.json())).not.toMatch(
    /PRIVATE_ACTIVITY_|source_run_id|conversation_id/,
  );
  await contactStatus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/contact-background-retry.png` });
});

test("manager loads conflict pages with identical microsecond timestamps", async ({ page }) => {
  const subject = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Conflict pagination · synthetic')",
    [subject, org],
  );
  const memory = await saveCustomerMemory(pool, org, actor, {
    contact_id: subject,
    request_key: randomUUID(),
    category: "preference",
    body: "Synthetic payment preference awaiting business review.",
    confirmed: true,
    memory_type: "commercial_preference",
  });
  await pool.query(
    `insert into ai_customer_memory_conflicts(organization_id,contact_id,memory_id,conflict_key,kind,business_field,created_at)
    select $1,$2,$3,'pagination-fixture-'||n::text,'l0_l1','orders.payment_method','2026-11-11T00:00:00.123456Z' from generate_series(1,61) n`,
    [org, subject, memory.id],
  );
  if (ownsBootstrap) {
    await page.goto("/login");
    await page.locator("#email").fill(loginEmail);
    await page.locator("#password").fill(loginPassword);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
  } else await loginComoAdmin(page, lerCreds());
  await page.goto(`/app/contacts/${subject}`);
  const panel = page.getByRole("region", { name: "客户记忆", exact: true }),
    conflicts = panel.getByRole("region", { name: "记忆冲突待审", exact: true });
  await expect(conflicts.getByRole("article")).toHaveCount(50);
  await panel.getByRole("button", { name: "加载更多冲突" }).click();
  await expect(conflicts.getByRole("article")).toHaveCount(61);
  await expect(panel.getByRole("button", { name: "加载更多冲突" })).toHaveCount(0);
  await conflicts.getByRole("article").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/manager-paginated-conflicts.png` });
});
