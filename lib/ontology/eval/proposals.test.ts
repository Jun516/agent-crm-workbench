import { expect, it } from "vitest";
import { getOntology, ontologySnapshot, resolveReceipt } from "../versions";
import { validateOntology } from "../contract";
import { proposeMetricChange } from "./proposals";

it("keeps a model proposal untrusted and preserves the old receipt", () => {
  const original = getOntology("1.0.0");
  const receipt = ontologySnapshot(original);
  const proposal = proposeMetricChange({
    base: { version: receipt.version, digest: receipt.digest },
    candidateVersion: "1.0.1",
    metricId: "high_value",
    definition: "A candidate definition requiring business review",
    missing: ["Human review"],
  });
  expect(proposal.candidate.metrics.find((metric) => metric.id === "high_value")).toMatchObject({
    origin: "model",
    status: "proposed",
    review: null,
    version: "1.0.1",
  });
  expect(proposal.changes).toContain("version");
  expect(resolveReceipt(receipt)).toEqual(original);
  const forged = structuredClone(proposal.candidate);
  forged.metrics.find((metric) => metric.id === "high_value")!.status = "certified";
  expect(() => validateOntology(forged)).toThrow(/model draft/);
  expect(() =>
    proposeMetricChange({
      base: { version: receipt.version, digest: "bad" },
      candidateVersion: "1.0.1",
      metricId: "high_value",
      definition: "x",
      missing: ["review"],
    }),
  ).toThrow(/digest/);
});
