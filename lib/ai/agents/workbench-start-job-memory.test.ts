import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { Pool } from "pg";
import { governParentOnExpertConflict } from "./expert-conflict-governance";

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  event: vi.fn(async () => 1),
  query: vi.fn(),
  admin: vi.fn(),
  collaboration: vi.fn(),
  refinement: vi.fn(),
  runtimeState: vi.fn(),
  selectPlan: vi.fn(),
  scope: vi.fn(),
  tools: vi.fn(),
  update: vi.fn(),
  transactionQuery: vi.fn(),
  release: vi.fn(),
  project: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({
  executePiTurnModelCall: mocks.model,
}));
vi.mock("@/lib/ai/agents/workbench-events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ai/agents/workbench-events")>(),
  appendWorkbenchEvent: mocks.event,
  projectTerminalWorkbenchRun: mocks.project,
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({
  requestTurnDeps: () => ({ crmCfg: {}, llmCfg: {}, log: {}, runtime: {} }),
}));
vi.mock("@/lib/ai/agents/workbench-job-lease", () => ({ assertWorkbenchJobLease: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: async () => ({
    systemPrompt: "CRM playbook",
    model: "test",
    maxSteps: 8,
  }),
}));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: mocks.tools,
}));
vi.mock("@/lib/ai/agents/workbench-scope", () => ({
  resolveWorkbenchScope: mocks.scope,
}));
vi.mock("@/lib/ai/agents/collaboration", () => ({
  selectCollaborationPlan: mocks.selectPlan,
  collaborationPlanForMission: (plan: unknown) => plan,
}));
vi.mock("@/lib/ai/agents/workbench-collaboration", () => ({
  runWorkbenchCollaboration: mocks.collaboration,
}));
vi.mock("@/lib/ai/agents/refinement-workbench", () => ({
  runWorkbenchRefinement: mocks.refinement,
}));
import { runWorkbenchStartJob } from "./workbench-start-job";

const job = {
  id: "job1",
  organization_id: "org1",
  payload: { runId: "run1" },
  attempts: 1,
  max_attempts: 3,
} as unknown as JobRow;
const pool = {
  query: mocks.query,
  connect: async () => ({ query: mocks.transactionQuery, release: mocks.release }),
} as unknown as Pool;
const policyRow = {
  id: "version3",
  version_id: "version3",
  organization_id: "org1",
  version_number: 3,
  content: "Published organization policy",
  created_at: "2026-10-01T00:00:00Z",
  published_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectPlan.mockReturnValue(null);
  mocks.collaboration.mockResolvedValue(null);
  mocks.runtimeState.mockReturnValue({ versionId: "agent-version1" });
  mocks.tools.mockResolvedValue({ tools: {}, cleanup: vi.fn() });
  mocks.scope.mockResolvedValue({
    contactId: null,
    leadId: null,
    conversationId: null,
    pipelineId: null,
  });
  mocks.model.mockRejectedValue(new Error("stop_after_model_input"));
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("from org_memory_pointers") ? [policyRow] : [],
  }));
  mocks.transactionQuery.mockImplementation(async (sql: string) => ({
    rowCount: sql.startsWith("update public.ai_workbench_runs") ? 1 : null,
    rows: sql.startsWith("insert into public.ai_agent_run_events") ? [{ sequence: 1 }] : [],
  }));
  mocks.admin.mockReturnValue({
    from: (table: string) => {
      const data =
        table === "ai_workbench_runs"
          ? {
              id: "run1",
              status: "running",
              agent_id: "agent1",
              task: "Check CRM",
              mode: "inspect",
              runtime_state: mocks.runtimeState(),
              mission_id: null,
              scope: {},
              budget: {},
            }
          : table === "ai_agent_action_proposals"
            ? []
            : null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        update: (value: unknown) => {
          mocks.update(table, value);
          return builder;
        },
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(resolve({ data, error: null })),
      };
      return builder;
    },
  });
});

function setGovernedPlan() {
  mocks.selectPlan.mockReturnValue({ key: "test-plan" });
  mocks.collaboration.mockResolvedValue({
    governance: governParentOnExpertConflict([{
      code: "evidence_disagreement",
      specialistKeys: ["first", "second"],
      field: "lead.stage",
      message: "Conflicting stage evidence",
    }]),
    usage: { inputTokens: 120, outputTokens: 60, costCents: 2 },
    results: [{}, {}],
  });
}

describe("Workbench initial organization memory", () => {
  it("injects published policies before any model/tool decision and emits body-free provenance", async () => {
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls[0]![0]).not.toHaveProperty("customerMemory");
    const input = mocks.model.mock.calls[0]![1];
    expect(input.system).toContain("CRM playbook\n\n=== memória da organização");
    expect(input.system).toContain(policyRow.content);
    expect(input.system).toContain("Revisão: sha256:");
    expect(mocks.event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "context_loaded",
        payload: {
          orgMemoryRevision: expect.stringMatching(/^sha256:/),
          orgMemoryVersionId: "version3",
          orgMemoryVersionNumber: 3,
          orgMemoryEntriesCount: 0,
          memoryResolution: "current_published",
        },
      }),
    );
  });

  it("passes the same policy-bearing configuration to specialists and retains it in their system prompt", async () => {
    const scope = { contactId: "contact", leadId: "lead", conversationId: "conversation", pipelineId: null };
    mocks.scope.mockResolvedValue(scope);
    mocks.selectPlan.mockReturnValue({ key: "test-plan" });
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.collaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMemoryBeforeRead: expect.any(Function),
        agentConfig: expect.objectContaining({
          systemPrompt: expect.stringContaining(policyRow.content),
        }),
      }),
    );
    expect(mocks.refinement).not.toHaveBeenCalled();
    expect(mocks.model.mock.calls[0]![0]).toHaveProperty("customerMemory", {
      contactId: scope.contactId,
      conversationId: scope.conversationId,
      leadId: scope.leadId,
      task: "Check CRM",
      beforeRead: expect.any(Function),
    });
    const specialist = readFileSync("lib/ai/agents/workbench-collaboration.ts", "utf8");
    expect(specialist).toMatch(/system:\s*\[\s*(?:\/\/[^\n]*\n\s*)*childConfig\.systemPrompt/);
  });

  it("keeps customer recall and normal collaboration out of opt-in refinement", async () => {
    mocks.scope.mockResolvedValue({ contactId: "contact", leadId: "lead", conversationId: "conversation", pipelineId: null });
    mocks.runtimeState.mockReturnValue({ versionId: "agent-version1", refinement: {} });
    mocks.refinement.mockResolvedValue({ state: { lessonCodes: [], rounds: [] }, collaboration: null });

    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow("stop_after_model_input");

    expect(mocks.refinement).toHaveBeenCalledOnce();
    expect(mocks.selectPlan).toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
    expect(mocks.collaboration).not.toHaveBeenCalled();
    expect(mocks.model.mock.calls[0]![0]).not.toHaveProperty("customerMemory");
  });

  it("does not call the model when the policy database fails", async () => {
    mocks.query.mockRejectedValue(new Error("memory_database_unavailable"));
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "memory_database_unavailable",
    );
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.collaboration).not.toHaveBeenCalled();
  });

  it("closes the parent for human review before building its tools or calling its model", async () => {
    setGovernedPlan();
    await runWorkbenchStartJob(job, pool, "worker1");
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("set status='partial'"),
      ["org1", "run1", expect.stringContaining("请负责人确认"), "expert_conflict_unresolved"],
    );
    expect(mocks.transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("insert into public.ai_agent_run_events"),
      ["org1", "run1", "run_partial", JSON.stringify({
        status: "partial", pendingProposals: 0, reason: "expert_conflict_unresolved",
      })],
    );
    expect(mocks.transactionQuery.mock.calls.at(-1)).toEqual(["commit"]);
    expect(mocks.project).toHaveBeenCalledWith("org1", "run1");
  });

  it("rolls back the governed terminal state if its evidence cannot be written", async () => {
    setGovernedPlan();
    const query = mocks.transactionQuery.getMockImplementation()!;
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("insert into public.ai_agent_run_events")) {
        throw new Error("event_persistence_unavailable");
      }
      return query(sql);
    });
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "event_persistence_unavailable",
    );
    expect(mocks.transactionQuery.mock.calls.at(-1)).toEqual(["rollback"]);
    expect(mocks.transactionQuery).not.toHaveBeenCalledWith("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });
});
