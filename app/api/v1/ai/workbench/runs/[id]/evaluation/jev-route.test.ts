import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  jev: vi.fn(),
  llmBinding: vi.fn(),
  project: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock("@/lib/ai/jev/client", () => ({
  evaluateJevChoices: mocks.jev,
  JEV_CLIENT_REVISION: "jev-choice-v1",
}));
vi.mock("@/lib/ai/integrations/langfuse", () => ({ projectLangfuseEvaluation: mocks.project }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn().mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { id: "user" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: mocks.llmBinding,
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/ai/agents/workbench-observed-evidence", () => ({
  loadWorkbenchObservedEvidence: mocks.evidence,
}));
import { GET, POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
let finalText = "## 结论\n\n提供必要资料后可进一步核对。";
const contactId = "22222222-2222-4222-8222-222222222222";
let scope: Record<string, string> = {};
let contactEligible = true;
let messages: unknown[] = [];
const wiki = {
  id: "wiki",
  namespace: "organization_wiki",
  title: "Allowed source",
  excerpt: "HISTORICAL_WIKI_CANARY",
  locator: { provider: "local", sourceId: "source", revision: "rev1" },
};
const wikiMessage = () => ({
  role: "tool",
  toolCallId: "knowledge",
  toolName: "crm_search_knowledge",
  content: JSON.stringify({ evidence: [wiki] }),
});
type Stored = { report: unknown; input_fingerprint: string; organization_id: string };
const stored = new Map<string, Stored>();
function db() {
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const response = (single = false) => ({
      error: null,
      data:
        table === "ai_workbench_runs"
          ? filters.parent_run_id
            ? []
            : {
                id,
                agent_id: "agent",
                task: "Read product knowledge",
                mode: "inspect",
                status: "completed",
                final_text: finalText,
                updated_at: "2026-10-28T00:00:00Z",
                runtime_state: {},
                scope,
              }
          : table === "ai_agent_run_states"
            ? { messages }
            : table === "contacts"
              ? single
                ? { id: contactId }
                : contactEligible
                  ? [{ id: contactId }]
                  : []
              : table === "ai_agents"
                ? { origin: "user" }
                : table === "ai_agent_eval_reports"
                  ? single
                    ? (stored.get(String(filters.input_fingerprint)) ?? null)
                    : [...stored.values()].reverse()
                  : [],
    });
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        filters[key] = value;
        return builder;
      },
      in: () => builder,
      order: () => builder,
      is: () => builder,
      lte: () => builder,
      or: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(response(true)),
      upsert: async (row: Stored) => {
        stored.set(row.input_fingerprint, row);
        return { error: null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return builder;
  });
}
function result() {
  return {
    model: "jev-1.2.3",
    answers: {
      relevance: {
        type: "choice",
        choice: "relevant",
        confidence: 0.9,
        probabilities: { relevant: 0.95, irrelevant: 0.025, insufficient: 0.025 },
      },
      output_quality: {
        type: "choice",
        choice: "acceptable",
        confidence: 0.9,
        probabilities: { acceptable: 0.95, unacceptable: 0.025, insufficient: 0.025 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
    requestFingerprint: "a".repeat(64),
  };
}
const ctx = () => ({ params: Promise.resolve({ id }) });
const post = () =>
  POST(
    new NextRequest(`http://localhost/runs/${id}/evaluation?mode=jev`, { method: "POST" }),
    ctx(),
  );
const get = () => GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), ctx());
beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  db();
  finalText = "## 结论\n\n提供必要资料后可进一步核对。";
  scope = {};
  contactEligible = true;
  messages = [];
  mocks.evidence.mockReset().mockResolvedValue([]);
  vi.stubEnv("TYPESAFE_API_KEY", "SERVER_SECRET_CANARY");
  vi.stubEnv("JEV_MODEL", "jev-1.2.3");
  vi.stubEnv("AI_INTEGRATION_BINDINGS", "");
  mocks.jev.mockReset().mockResolvedValue(result());
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit Jev evaluation route", () => {
  it("does not invoke Jev on GET and runs independently of the original LLM binding", async () => {
    expect((await get()).status).toBe(200);
    expect(mocks.jev).not.toHaveBeenCalled();
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.semanticJudge.choiceReview).toMatchObject({
      model: "jev-1.2.3",
      confidenceThreshold: 0.8,
    });
    expect(mocks.llmBinding).not.toHaveBeenCalled();
    expect(mocks.jev).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("SERVER_SECRET_CANARY");
  });
  it("only reuses the pinned model/material/policy cache and restores separate Jev history", async () => {
    expect((await post()).status).toBe(200);
    const second = await (await post()).json();
    expect(second.data.cached).toBe(true);
    expect(mocks.jev).toHaveBeenCalledTimes(1);
    const body = await (await get()).json();
    expect(body.data.savedJevEvaluation.semanticJudge.choiceReview.model).toBe("jev-1.2.3");
    expect(body.data.savedSemanticEvaluation).toBeNull();
    expect(mocks.jev).toHaveBeenCalledTimes(1);
  });
  it("never reuses an alias and preserves independent attempt receipts", async () => {
    vi.stubEnv("JEV_MODEL", "jev-latest");
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(mocks.jev).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(2);
    expect(
      (await (await get()).json()).data.savedJevEvaluation.semanticJudge.choiceReview
        .requestedModel,
    ).toBe("jev-latest");
  });
  it("reports missing optional configuration without a request or original LLM fallback", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect((await post()).status).toBe(503);
    expect(mocks.jev).not.toHaveBeenCalled();
    expect(mocks.llmBinding).not.toHaveBeenCalled();
  });
  it("keeps deterministic safety failures even with positive confident choices", async () => {
    finalText = "Now produce the final answer.\n\n## 正式答案\n结论。";
    expect((await (await post()).json()).data.verdict).toBe("fail");
  });
  it("rejects a currently anonymized or merged contact before calling Jev", async () => {
    scope = { contactId };
    contactEligible = false;
    expect((await post()).status).toBe(409);
    expect(mocks.jev).not.toHaveBeenCalled();
  });
  it("omits revoked historical knowledge and forces human review", async () => {
    messages = [wikiMessage()];
    const body = await (await post()).json();
    expect(body.data.semanticJudge.verdict).toBe("needs_review");
    expect(JSON.stringify(mocks.jev.mock.calls[0]![0].state)).not.toContain(
      "HISTORICAL_WIKI_CANARY",
    );
    expect(mocks.evidence).toHaveBeenCalled();
  });
  it("refuses to send a knowledge projection withdrawn during the cache wait", async () => {
    messages = [wikiMessage()];
    mocks.evidence
      .mockResolvedValueOnce([
        {
          id: "wiki",
          namespace: "organization_wiki",
          revision: "rev1",
          title: "Allowed source",
          excerpt: "WITHDRAWN_DURING_WAIT",
          index_status: "current",
        },
      ])
      .mockResolvedValue([]);
    expect((await post()).status).toBe(409);
    expect(mocks.evidence).toHaveBeenCalledTimes(2);
    expect(mocks.jev).not.toHaveBeenCalled();
  });
  it("sends only currently authorized matching knowledge and invalidates cache after withdrawal", async () => {
    messages = [wikiMessage()];
    mocks.evidence.mockResolvedValue([
      {
        id: "wiki",
        namespace: "organization_wiki",
        revision: "rev1",
        title: "Allowed source",
        excerpt: "CURRENT_APPROVED_CANARY",
        index_status: "current",
      },
    ]);
    expect((await post()).status).toBe(200);
    expect(mocks.jev.mock.calls[0]![0].state.knowledgeEvidence[0].excerpt).toBe(
      "CURRENT_APPROVED_CANARY",
    );
    mocks.evidence.mockResolvedValue([]);
    const body = await (await post()).json();
    expect(body.data.cached).toBe(false);
    expect(body.data.semanticJudge.verdict).toBe("needs_review");
    expect(mocks.jev).toHaveBeenCalledTimes(2);
  });
  it("does not send superseded or wrong-version knowledge", async () => {
    messages = [wikiMessage()];
    mocks.evidence.mockResolvedValue([
      {
        id: "wiki",
        namespace: "organization_wiki",
        revision: "rev2",
        title: "Changed source",
        excerpt: "WRONG_REVISION_CANARY",
        index_status: "current",
      },
    ]);
    const body = await (await post()).json();
    expect(body.data.semanticJudge.verdict).toBe("needs_review");
    expect(JSON.stringify(mocks.jev.mock.calls[0]![0].state)).not.toContain(
      "WRONG_REVISION_CANARY",
    );
  });
  it("persists invalid/timeout review failures and GET never retries them", async () => {
    mocks.jev.mockRejectedValue(
      Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE SERVER_SECRET_CANARY"), {
        name: "JevClientError",
      }),
    );
    const posted = await (await post()).json();
    expect(posted.data.verdict).not.toBe("pass");
    expect(posted.data.semanticJudge).toMatchObject({ status: "failed", provider: "jev" });
    await post();
    expect(stored.size).toBe(2);
    const restored = await (await get()).json();
    expect(restored.data.savedJevEvaluation.semanticJudge.status).toBe("failed");
    expect(mocks.jev).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(restored)).not.toMatch(/PRIVATE_PROVIDER_MESSAGE|SERVER_SECRET_CANARY/);
  });
});
