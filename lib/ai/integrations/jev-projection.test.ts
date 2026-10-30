import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentEvalReport } from "@/lib/ai/evals/contracts";
import { projectLangfuseEvaluation, exportLangfuseEvent } from "./langfuse";
import type { EventRow } from "@/lib/event-log/dispatcher";

afterEach(() => vi.unstubAllEnvs());
it("mirrors only numeric allowlisted confidence and never Jev state, choice or probabilities", async () => {
  const org = "a0000000-0000-4000-8000-000000000001";
  vi.stubEnv(
    "AI_INTEGRATION_BINDINGS",
    JSON.stringify([
      {
        organization_id: org,
        provider: "langfuse",
        base_url: "https://trace.test",
        public_key: "synthetic",
        secret_key: "synthetic",
      },
    ]),
  );
  let payload: unknown;
  const pool = {
    query: vi.fn(async (query: string | { text: string; values: unknown[] }, args?: unknown[]) => {
      const text = typeof query === "string" ? query : query.text;
      const values = typeof query === "string" ? (args ?? []) : query.values;
      if (text.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
      if (text.includes("select parent_run_id")) return { rows: [{ parent_run_id: null }] };
      if (text.includes("insert into event_log")) payload = JSON.parse(values[3] as string);
      return { rows: [] };
    }),
  } as unknown as Pool;
  await projectLangfuseEvaluation(
    pool,
    org,
    {
      runId: "a0000000-0000-4000-8000-000000000002",
      profileRevision: 1,
      score: 80,
      dimensions: [
        "task_completion",
        "answer_quality",
        "knowledge_grounding",
        "tool_reliability",
        "policy_compliance",
        "efficiency",
        "collaboration_quality",
      ].map((key) => ({ key, score: 80 })),
      semanticJudge: {
        status: "completed",
        rubricRevision: 1,
        score: 100,
        choiceReview: {
          state: "PRIVATE_STATE_CANARY",
          decisions: [
            {
              criterion: "relevance",
              confidence: 0.8,
              choice: "PRIVATE_CHOICE_CANARY",
              probabilities: { PRIVATE_PROB_CANARY: 1 },
            },
            { criterion: "output_quality", confidence: 0.7 },
            { criterion: "PRIVATE_CRITERION_CANARY", confidence: 0.9 },
          ],
        },
      },
    } as unknown as AgentEvalReport,
    "a".repeat(64),
  );
  const text = JSON.stringify(payload);
  expect(text).toContain("crm.jev_relevance_confidence");
  expect(text).toContain("crm.jev_output_quality_confidence");
  expect(text).not.toContain("PRIVATE_");
  expect(text).not.toContain("probabilities");
  const http = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.batch).toHaveLength(11);
    return new Response(
      JSON.stringify({
        successes: body.batch.map((item: { id: string }) => ({ id: item.id })),
        errors: [],
      }),
      { status: 207 },
    );
  });
  await exportLangfuseEvent(
    {
      id: "a0000000-0000-4000-8000-000000000003",
      organization_id: org,
      entity_id: "a0000000-0000-4000-8000-000000000002",
      payload,
    } as unknown as EventRow,
    pool,
    http as unknown as typeof fetch,
  );
  expect(http).toHaveBeenCalledTimes(1);
});
