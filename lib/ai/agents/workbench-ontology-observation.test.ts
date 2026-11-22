import { expect, it } from "vitest";
import {
  ontologyObjectScopeRefusal,
  ontologyPipelineScope,
} from "./workbench-ontology-observation";

it("derives the read scope from the workbench selection", () => {
  expect(ontologyPipelineScope({})).toBeNull();
  expect(ontologyPipelineScope({ pipelineId: "b" })).toEqual(["b"]);
  expect(ontologyPipelineScope({ leadId: "lead", pipelineId: "a" })).toEqual([]);
  expect(ontologyObjectScopeRefusal("ontology_query", { leadId: "lead" })).toMatchObject({
    status: "unanswerable",
    degraded: true,
  });
});
