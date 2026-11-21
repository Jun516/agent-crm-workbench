import { describe, expect, it, vi } from "vitest";
import { ontologyCheckAnswerable, ontologyQuery } from "./ontology";
import type { McpContext } from "../types";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ontology/execute-runtime-read-plan", () => ({ executeRuntimeReadPlan: execute }));
const ctx = {
  actor: { type: "ai_agent" },
  ontologyRuntime: { versionId: "version", runId: "run", pipelineIds: ["pipeline"] },
} as unknown as McpContext;

describe("ontology tools", () => {
  it("does not silently discard unsupported business criteria", async () => {
    const result = await ontologyCheckAnswerable.handler(
      { question: "quais oportunidades de alto valor sem follow-up?" },
      ctx,
    );
    expect(result).toMatchObject({ status: "unsupported", degraded: true });
    expect(
      await ontologyQuery.handler(
        { question: "quais oportunidades de alto valor sem follow-up?" },
        ctx,
      ),
    ).toMatchObject({ status: "unanswerable", degraded: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it("passes explicit assumptions and the trusted runtime binding to the planner", async () => {
    execute.mockResolvedValueOnce({ rows: [], receipt: { partial: true } });
    const assumption = {
      minimumValueCents: 100000,
      currency: "BRL",
      from: "2026-10-31T00:00:00Z",
      to: "2026-11-14T00:00:00Z",
      activityTypes: ["appointment_completed" as const],
    };
    const result = await ontologyQuery.handler({ assumption }, ctx);
    expect(result).toMatchObject({ status: "partial", assumption: true, degraded: false });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ template: "explicit_activity_gap_v1", criteria: assumption }),
      ctx,
      ctx.ontologyRuntime,
      undefined,
    );
  });
  it("does not expose database exceptions", async () => {
    execute.mockRejectedValueOnce(new Error("secret SQL"));
    const result = await ontologyQuery.handler({ question: "quais negócios estão abertos?" }, ctx);
    expect(result).toMatchObject({ status: "unanswerable", degraded: true });
    expect(JSON.stringify(result)).not.toContain("secret SQL");
  });
});

it("reports a permission denial without disclosing the underlying exception", async () => {
  execute.mockRejectedValueOnce(new Error("ontology_forbidden"));
  const result = await ontologyQuery.handler({ question: "quais negócios estão abertos?" }, ctx);
  expect(result).toMatchObject({
    status: "unanswerable",
    degraded: true,
    missing: ["Acesso semântico recusado."],
  });
});

it("passes the run cancellation signal into the executor", async () => {
  const controller = new AbortController();
  const context = {
    ...ctx,
    ontologyRuntime: { ...ctx.ontologyRuntime!, signal: controller.signal },
  };
  execute.mockRejectedValueOnce(new Error("ontology_cancelled"));
  const result = await ontologyQuery.handler(
    { question: "quais negócios estão abertos?" },
    context,
  );
  expect(execute).toHaveBeenLastCalledWith(
    expect.anything(),
    context,
    context.ontologyRuntime,
    controller.signal,
  );
  expect(result).toMatchObject({ missing: ["Consulta cancelada."] });
});

it("asks for a scope rather than presenting an empty scope as an empty result", async () => {
  const context = { ...ctx, ontologyRuntime: { ...ctx.ontologyRuntime!, pipelineIds: [] } };
  const result = await ontologyQuery.handler(
    { question: "quais negócios estão abertos?" },
    context,
  );
  expect(result).toMatchObject({ status: "unanswerable", degraded: true });
  expect(JSON.stringify(result)).toContain("Selecione um funil");
});
