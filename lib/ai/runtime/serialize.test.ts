import { expect, it } from "vitest";
import { serializeSteps } from "./serialize";

it("persists only bounded status metadata for semantic tool steps", () => {
  const [step] = serializeSteps([{
    toolCalls: [
      { toolName: "ontology_query", input: { question: "private question" } },
      { toolName: "ontology_describe_outcome", input: {} },
      { toolName: "crm_lookup", input: { token: "fixture secret", count: 2 } },
    ],
    toolResults: [
      { output: { rows: [{ name: "private account" }], status: "full", degraded: false } },
      { output: { status: "private unrecognized text" } },
      { output: { count: 2 } },
    ],
  }]);
  expect(step?.tool_calls).toEqual([
    {
      tool_name: "ontology_query",
      args: { redacted: true },
      result: { redacted: true, status: "full", degraded: false },
    },
    {
      tool_name: "ontology_describe_outcome",
      args: { redacted: true },
      result: { redacted: true },
    },
    {
      tool_name: "crm_lookup",
      args: { token: "[redacted]", count: 2 },
      result: { count: 2 },
    },
  ]);
});
