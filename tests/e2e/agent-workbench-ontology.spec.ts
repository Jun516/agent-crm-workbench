import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { startOntologyModelFixture } from "./helpers/ontology-model-fixture";

test("synthetic provider: configuração publicada e evidência semântica sobrevivem ao refresh", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
    throw new Error("local_supabase_required");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const fixture = await startOntologyModelFixture();
  try {
    // No external provider is called: this exact local endpoint supplies every
    // synthetic response. The model ID below only selects a known pricing entry.
    expect(process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "")).toBe(fixture.baseUrl);
    await loginComoAdmin(page, lerCreds());
    const creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8")) as {
      org_id: string;
      followup_agent_fixtures: { channel_session_id: string };
    };
    const orgId = creds.org_id;
    // The isolated fixture does not send messages; publication requires the
    // same simulated connected session used by existing E2E seeds.
    const session = await admin
      .from("channel_sessions")
      .update({ status: "WORKING" })
      .eq("organization_id", orgId)
      .eq("id", creds.followup_agent_fixtures.channel_session_id);
    if (session.error) throw session.error;
    const { data: membership, error: memberError } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq("role", "admin")
      .is("revoked_at", null)
      .limit(1)
      .single();
    if (memberError || !membership) throw memberError ?? new Error("admin_missing");
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .single();
    if (orgError || !org) throw orgError ?? new Error("org_missing");
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    // Borrow this exact static pricing ID solely to exercise Mission's budget
    // guard; both tokens and resulting cost are synthetic fixture telemetry.
    const model = "claude-sonnet-4-6";
    const modelResult = await admin.from("ai_models").upsert(
      {
        provider: "openrouter",
        model_id: model,
        display_name: "Synthetic ontology E2E (simulated priced usage)",
        supports_tools: true,
        input_price_per_million_cents: 300,
        output_price_per_million_cents: 1500,
      },
      { onConflict: "provider,model_id" },
    );
    if (modelResult.error) throw modelResult.error;
    const orgUpdate = await admin
      .from("organizations")
      .update({
        settings: { ...settings, llm: { provider: "openrouter", default_model: model } },
        onboarded_at: new Date().toISOString(),
      })
      .eq("id", orgId);
    if (orgUpdate.error) throw orgUpdate.error;
    const key = Buffer.from(process.env.AI_CRED_AES_KEY ?? "", "base64");
    if (key.length !== 32) throw new Error("e2e_aes_key_missing");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("synthetic-ontology-key"), cipher.final()]);
    const credential = await admin
      .from("ai_provider_credentials")
      .insert({
        organization_id: orgId,
        provider: "openrouter",
        label: `ontology-${randomUUID()}`,
        api_key_encrypted: `\\x${encrypted.toString("hex")}`,
        api_key_iv: `\\x${iv.toString("hex")}`,
        api_key_tag: `\\x${cipher.getAuthTag().toString("hex")}`,
        api_key_last4: "-key",
        is_active: true,
        validated_at: new Date().toISOString(),
        created_by: membership.user_id,
      })
      .select("id")
      .single();
    if (credential.error || !credential.data)
      throw credential.error ?? new Error("credential_missing");
    const pipeline = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: orgId,
        name: "Ontology synthetic",
        slug: `ont-${randomUUID().slice(0, 8)}`,
      })
      .select("id, name")
      .single();
    if (pipeline.error || !pipeline.data) throw pipeline.error ?? new Error("pipeline_missing");
    const stage = await admin
      .from("crm_stages")
      .insert({
        organization_id: orgId,
        pipeline_id: pipeline.data.id,
        name: "Synthetic",
        slug: "synthetic",
        position: 1,
      })
      .select("id")
      .single();
    if (stage.error || !stage.data) throw stage.error ?? new Error("stage_missing");
    const lead = await admin
      .from("crm_leads")
      .insert({
        organization_id: orgId,
        pipeline_id: pipeline.data.id,
        stage_id: stage.data.id,
        title: "Synthetic opportunity",
        value_cents: 100000,
        currency: "BRL",
      })
      .select("id")
      .single();
    if (lead.error || !lead.data) throw lead.error ?? new Error("lead_missing");
    const activity = await admin.from("crm_lead_activities").insert({
      organization_id: orgId,
      lead_id: lead.data.id,
      source_module: "manual",
      type: "appointment_completed",
      performed_at: "2026-10-01T00:00:00Z",
    });
    if (activity.error) throw activity.error;

    const agentsResponse = await page.request.get("/api/v1/ai/agents");
    expect(agentsResponse.ok()).toBeTruthy();
    const agents = (await agentsResponse.json()).data as Array<{ id: string; builtin_key: string }>;
    const agent = agents.find((item) => item.builtin_key === "crm_intelligence");
    expect(agent).toBeDefined();
    const draft = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", orgId)
      .eq("agent_id", agent!.id)
      .eq("status", "draft")
      .order("version_number", { ascending: false })
      .limit(1)
      .single();
    if (draft.error || !draft.data) throw draft.error ?? new Error("draft_missing");
    const oldTools = [
      "crm_search_contacts",
      "crm_get_contact",
      "crm_list_leads",
      "crm_get_lead",
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_search_knowledge",
      "crm_get_org_memory",
    ];
    const draftUpdate = await admin
      .from("ai_agent_versions")
      .update({ tool_ids: oldTools })
      .eq("id", draft.data.id)
      .eq("organization_id", orgId);
    if (draftUpdate.error) throw draftUpdate.error;
    // Existing unmodified built-ins receive the new tools through normal synchronization.
    expect((await page.request.get("/api/v1/ai/agents")).ok()).toBeTruthy();
    const upgraded = await admin
      .from("ai_agent_versions")
      .select("tool_ids")
      .eq("id", draft.data.id)
      .single();
    expect(upgraded.data?.tool_ids).toEqual(
      expect.arrayContaining([
        "ontology_search_terms",
        "ontology_check_answerable",
        "ontology_query",
      ]),
    );

    // A copy is the product's supported customization path; enable and publish from its UI.
    await page.goto("/app/ai/workbench");
    await page.getByLabel("内置 Agent").selectOption({ label: "CRM 情报员" });
    await page.getByRole("button", { name: "任务设置" }).click();
    await page.getByRole("button", { name: "复制并定制" }).click();
    await page.waitForURL(/\/app\/ai\/agents\/[0-9a-f-]{36}/);
    const copyId = page.url().split("/").pop()!;
    const copyDraft = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("agent_id", copyId)
      .eq("status", "draft")
      .order("version_number", { ascending: false })
      .limit(1)
      .single();
    if (copyDraft.error || !copyDraft.data)
      throw copyDraft.error ?? new Error("copy_draft_missing");
    const copyUpdate = await admin
      .from("ai_agent_versions")
      .update({
        tool_ids: ["crm_list_leads"],
        provider: "openrouter",
        model,
        credential_id: credential.data.id,
        channel_session_id: creds.followup_agent_fixtures.channel_session_id,
        pipeline_ids: [],
      })
      .eq("id", copyDraft.data.id)
      .eq("organization_id", orgId);
    if (copyUpdate.error) throw copyUpdate.error;
    await page.reload();
    await page.getByRole("button", { name: /Escolher uma a uma/ }).click();
    for (const name of ["ontology_search_terms", "ontology_check_answerable", "ontology_query", "ontology_describe_action", "ontology_describe_outcome", "crm_manage_tags"])
      await page.getByTestId(`capacidade-${name}`).locator("input").check();
    await page.getByTestId("papel-operacao").click();
    await page.getByTestId(`funil-${pipeline.data.id}`).check();
    await page.getByRole("button", { name: /Salvar rascunho/ }).click();
    await expect(page.getByRole("button", { name: /Publicar v/ }).first()).toBeEnabled();
    await page
      .getByRole("button", { name: /Publicar v/ })
      .first()
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /Publicar v/ })
      .click();
    await expect
      .poll(
        async () =>
          (await admin.from("ai_agents").select("published_version_id").eq("id", copyId).single())
            .data?.published_version_id,
      )
      .toBeTruthy();

    for (const [marker, status, selectPipeline] of [
      ["ONTOLOGY_FULL_UNSCOPED", "完整", false],
      ["ONTOLOGY_FULL", "完整", true],
      ["ONTOLOGY_PARTIAL", "部分", true],
      ["ONTOLOGY_UNANSWERABLE", "无法回答", true],
    ] as const) {
      await page.goto("/app/ai/workbench");
      await page.getByLabel("内置 Agent").selectOption({ label: "CRM 情报员" });
      if (selectPipeline) {
        await page.getByRole("button", { name: "任务设置" }).click();
        await page.getByLabel("CRM 对象类型").selectOption("pipeline");
        await page.getByLabel("搜索 CRM 对象").fill(pipeline.data.name);
        await page.getByRole("button", { name: pipeline.data.name }).click();
        await page.keyboard.press("Escape");
      }
      await page.locator("#run-mode").selectOption("inspect");
      const task = marker.startsWith("ONTOLOGY_FULL")
        ? "列出授权范围内的开放商机。"
        : marker === "ONTOLOGY_PARTIAL"
          ? "找出高价值但最近 14 天没有有效跟进的开放商机。仅作为合成假设：100000 分、BRL、2026-10-31 至 2026-11-14（UTC）、appointment_completed；请解释依据与缺口。"
          : "找出高价值但没有有效跟进的开放商机；未提供高价值或有效跟进定义。";
      await page.locator("textarea").fill(`${marker} ${task}`);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/ai/workbench/runs") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "运行 Agent" }).click();
      const response = await responsePromise;
      expect(response.ok()).toBeTruthy();
      const runId = ((await response.json()).data as { run_id: string }).run_id;
      await page.getByRole("button", { name: "运行详情", exact: true }).click();
      await expect(page.getByLabel("语义依据")).toBeVisible({ timeout: 180_000 });
      await page.getByLabel("语义依据").locator(":scope > summary").click();
      await expect(page.getByLabel("语义依据")).toContainText(`状态：${status}`);
      await expect
        .poll(
          async () => {
            const detail = await page.request.get(`/api/v1/ai/workbench/runs/${runId}`);
            return ((await detail.json()).data as { status: string }).status;
          },
          { timeout: 180_000 },
        )
        .toBe(marker.startsWith("ONTOLOGY_FULL") ? "completed" : "partial");
      const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${runId}`);
      expect(detailResponse.ok()).toBeTruthy();
      const detail = (await detailResponse.json()).data as {
        status: string;
        error_code: string | null;
        events: Array<{ event_type: string; payload: Record<string, unknown> }>;
      };
      expect(detail.error_code).toBe(
        marker.startsWith("ONTOLOGY_FULL") ? null : "missing_material",
      );
      expect(detail.events.map((event) => event.event_type)).toEqual(
        expect.arrayContaining(["run_started", "tool_started", "tool_completed", "usage_reported"]),
      );
      const usage = detail.events.find((event) => event.event_type === "usage_reported")!.payload;
      expect(Number(usage.inputTokens) + Number(usage.outputTokens)).toBeLessThanOrEqual(32000);
      expect(typeof usage.costCents).toBe("number");
      expect(Number(usage.costCents)).toBeGreaterThan(0);
      expect(Number(usage.costCents)).toBeLessThan(50);
      const replay = await page.request.get(`/api/v1/ai/workbench/runs/${runId}/events?after=0`);
      expect(replay.ok()).toBe(true);
      expect(await replay.text()).toContain('"ontologyObservation":true');
      const observation = detail.events.find(
        (event) =>
          event.event_type === "tool_completed" && event.payload.ontologyObservation === true,
      );
      expect(observation).toBeDefined();
      expect(observation!.payload.status).toBe(
        marker.startsWith("ONTOLOGY_FULL")
          ? "full"
          : marker === "ONTOLOGY_PARTIAL"
            ? "partial"
            : "unanswerable",
      );
      if (marker !== "ONTOLOGY_UNANSWERABLE") {
        const receipt = observation!.payload.receipt as Record<string, unknown>;
        expect(receipt).toMatchObject({
          ontologyVersion: "1.0.0",
          effectivePipelineIds: selectPipeline ? [pipeline.data.id] : null,
          template: marker.startsWith("ONTOLOGY_FULL")
            ? "open_opportunities_v1"
            : "explicit_activity_gap_v1",
        });
        if (selectPipeline) expect(receipt.rowCount).toBe(1);
        else expect(Number(receipt.rowCount)).toBeGreaterThanOrEqual(1);
        if (marker === "ONTOLOGY_PARTIAL")
          expect(receipt.criteria).toEqual({
            minimumValueCents: 100000,
            currency: "BRL",
            from: "2026-10-31T00:00:00Z",
            to: "2026-11-14T00:00:00Z",
            activityTypes: ["appointment_completed"],
          });
      } else {
        expect(observation!.payload.degraded).toBe(true);
        expect(observation!.payload.missing).toEqual(
          expect.arrayContaining([expect.stringMatching(/certificad/)]),
        );
      }
      await page.keyboard.press("Escape");
      await page.goto(`/app/ai/workbench?run=${runId}`);
      await page.getByRole("button", { name: "运行详情", exact: true }).click();
      await expect(page.getByLabel("语义依据")).toBeVisible({ timeout: 30_000 });
      await page.getByLabel("语义依据").locator(":scope > summary").click();
      await expect(page.getByLabel("语义依据")).toContainText(`状态：${status}`);
      await page.keyboard.press("Escape");
    }

    const noExecutionLead = await admin.from("crm_leads").insert({ organization_id: orgId,
      pipeline_id: pipeline.data.id, stage_id: stage.data.id, title: "Synthetic planned opportunity" })
      .select("id").single();
    if (noExecutionLead.error || !noExecutionLead.data)
      throw noExecutionLead.error ?? new Error("planned_lead_missing");

    // The synthetic provider calls both descriptions in a real Mission turn.
    // It never issues a write or send: the evaluation must not infer success.
    const startMission = await page.request.post("/api/v1/ai/workbench/runs", { data: {
      agentId: copyId, mode: "act", collaboration: "disabled", scope: { leadId: noExecutionLead.data.id },
      task: "ONTOLOGY_MISSION 核对行动与验收要求，不要执行。",
      mission: { goal: "客户确认报价", acceptanceCriteria: "客户明确同意报价",
        acceptanceContract: { revision: 1, checks: [
          { kind: "lead_status", equals: "won" }, { kind: "customer_inbound_after_verified_send" },
        ] } },
    } });
    expect(startMission.ok(), await startMission.text()).toBeTruthy();
    const started = (await startMission.json()).data as { run_id: string; mission_id: string };
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
      return ((await response.json()).data as { status: string }).status;
    }, { timeout: 180_000 }).toBe("completed");
    const runResponse = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
    const missionRun = (await runResponse.json()).data as { status: string; error_code: string | null; events: Array<{event_type: string; payload: Record<string, unknown>}>; proposals: unknown[] };
    expect(missionRun).toMatchObject({ status: "completed", error_code: null });
    const missionUsage = missionRun.events.find((event) => event.event_type === "usage_reported")?.payload;
    expect(typeof missionUsage?.costCents).toBe("number");
    expect(Number(missionUsage?.costCents)).toBeGreaterThan(0);
    expect(Number(missionUsage?.costCents)).toBeLessThan(50);
    expect(missionRun.events.filter((event) => event.payload.ontologyObservation === true).map((event) => event.payload.tool))
      .toEqual(expect.arrayContaining(["ontology_describe_action", "ontology_describe_outcome"]));
    expect(missionRun.proposals).toHaveLength(0);
    const evaluation = await page.request.get(`/api/v1/ai/missions/${started.mission_id}/evaluation`);
    expect(evaluation.ok(), await evaluation.text()).toBeTruthy();
    const report = (await evaluation.json()).data as { businessOutcomeVerified: boolean; observableConditionsMet: boolean; observableChecks: Array<{verdict: string}> };
    expect(report.businessOutcomeVerified).toBe(false);
    expect(report.observableConditionsMet).toBe(false);
    expect(report.observableChecks.map((item) => item.verdict)).toEqual(["unmet", "unmet"]);
    await page.goto(`/app/ai/workbench?run=${started.run_id}`);
    await page.getByRole("button", { name: "运行详情", exact: true }).click();
    await expect(page.getByLabel("语义依据")).toBeVisible();
    await page.getByLabel("语义依据").locator(":scope > summary").click();
    await expect(page.getByLabel("语义依据")).toContainText("自由文本目标仍需核实");
    await page.keyboard.press("Escape");

    const other = await admin.from("crm_leads").insert({ organization_id: orgId,
      pipeline_id: pipeline.data.id, stage_id: stage.data.id, title: "Synthetic other opportunity" })
      .select("id,tags").single();
    if (other.error || !other.data) throw other.error ?? new Error("other_lead_missing");
    const refusedStart = await page.request.post("/api/v1/ai/workbench/runs", { data: {
      agentId: copyId, mode: "act", collaboration: "disabled", scope: { leadId: other.data.id },
      task: `ONTOLOGY_MISSION ONTOLOGY_TARGET=${lead.data.id} 先核对再提议标签。`,
      mission: { goal: "复核商机", acceptanceCriteria: "正确商机已核对" },
    } });
    expect(refusedStart.ok(), await refusedStart.text()).toBeTruthy();
    const refused = (await refusedStart.json()).data as { run_id: string };
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/ai/workbench/runs/${refused.run_id}`);
      return ((await response.json()).data as { status: string }).status;
    }, { timeout: 180_000 }).toBe("completed");
    const refusedResponse = await page.request.get(`/api/v1/ai/workbench/runs/${refused.run_id}`);
    const refusedRun = (await refusedResponse.json()).data as { status: string; error_code: string | null; events: Array<{event_type: string; payload: Record<string, unknown>}>; proposals: Array<{tool_name: string}> };
    expect(refusedRun).toMatchObject({ status: "completed", error_code: null });
    expect(refusedRun.events).toContainEqual(expect.objectContaining({ event_type: "policy_checked",
      payload: expect.objectContaining({ gate: "mission_scope", verdict: "denied", code: "mission_target_mismatch" }) }));
    expect(refusedRun.proposals.some((item) => item.tool_name === "crm_manage_tags")).toBe(false);
    const unchanged = await admin.from("crm_leads").select("tags").eq("organization_id", orgId).eq("id", lead.data.id).single();
    expect(unchanged.data?.tags ?? []).not.toContain("synthetic");

    await test.step("aprovação de proposta aplica tags pelo serviço CRM e retoma o Run", async () => {
      // This is the same no-contact opportunity returned by the earlier explicit
      // 100000 BRL / 14-day / appointment_completed query, not a certified metric.
      const target = lead;
      const startedResponse = await page.request.post("/api/v1/ai/workbench/runs", { data: {
        agentId: copyId, mode: "act", collaboration: "disabled", scope: { leadId: target.data.id },
        task: `ONTOLOGY_MISSION ONTOLOGY_TARGET=${target.data.id} Proponha a etiqueta para este negócio.`,
        mission: { goal: "核对高价值商机", acceptanceCriteria: "商机赢单",
          acceptanceContract: { revision: 1, checks: [{ kind: "lead_status", equals: "won" }] } },
      } });
      expect(startedResponse.ok(), await startedResponse.text()).toBe(true);
      const started = (await startedResponse.json()).data as { run_id: string; mission_id: string };
      await expect.poll(async () => {
        const response = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
        return ((await response.json()).data as { status: string }).status;
      }, { timeout: 180_000 }).toBe("awaiting_confirmation");
      const pendingResponse = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
      const pending = (await pendingResponse.json()).data as { error_code: string | null; proposals: Array<{id: string; tool_name: string; status: string}> };
      expect(pending.error_code).toBeNull();
      const proposal = pending.proposals.find((p) => p.tool_name === "crm_manage_tags");
      expect(proposal).toMatchObject({ status: "pending" });
      const before = await admin.from("crm_leads").select("tags").eq("organization_id", orgId).eq("id", target.data.id).single();
      expect(before.data?.tags ?? []).not.toContain("synthetic");
      const pendingEvaluation = await page.request.get(`/api/v1/ai/missions/${started.mission_id}/evaluation`);
      expect(pendingEvaluation.ok(), await pendingEvaluation.text()).toBe(true);
      const pendingReport = (await pendingEvaluation.json()).data as {
        businessOutcomeVerified: boolean;
        observableConditionsMet: boolean;
        observableChecks: Array<{ verdict: string }>;
      };
      expect(pendingReport).toMatchObject({ businessOutcomeVerified: false, observableConditionsMet: false });
      expect(pendingReport.observableChecks.map((check) => check.verdict)).toEqual(["unmet"]);
      const decision = await page.request.post(`/api/v1/ai/workbench/runs/${started.run_id}/proposals/${proposal!.id}/decision`,
        { data: { decision: "approve", reason: "Confirmar teste sintético" } });
      expect(decision.ok(), await decision.text()).toBe(true);
      await expect.poll(async () => {
        const response = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
        return ((await response.json()).data as { status: string }).status;
      }, { timeout: 180_000 }).toBe("completed");
      const finishedResponse = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
      const finished = (await finishedResponse.json()).data as { status: string; error_code: string | null;
        proposals: Array<{ id: string; status: string }>; events: Array<{event_type: string}> };
      expect(finished).toMatchObject({ status: "completed", error_code: null });
      expect(finished.proposals.find((p) => p.id === proposal!.id)).toMatchObject({ status: "executed" });
      expect(finished.events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "human_confirmation_requested", "human_confirmation_received", "tool_completed", "run_resumed", "run_completed",
      ]));
      const changed = await admin.from("crm_leads").select("tags").eq("organization_id", orgId).eq("id", target.data.id).single();
      expect(changed.data?.tags).toContain("synthetic");
      const evaluation = await page.request.get(`/api/v1/ai/missions/${started.mission_id}/evaluation`);
      expect(evaluation.ok(), await evaluation.text()).toBe(true);
      expect((await evaluation.json()).data).toMatchObject({ businessOutcomeVerified: false, observableConditionsMet: false });
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
