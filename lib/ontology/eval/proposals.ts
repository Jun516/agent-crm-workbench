import { z } from "zod";
import { validateOntology, type Ontology } from "../contract";
import { diffOntology, ontologyDigest, resolveReceipt } from "../versions";

const proposalSchema = z
  .object({
    base: z.object({ version: z.string(), digest: z.string() }).strict(),
    candidateVersion: z
      .string()
      .max(40)
      .regex(/^\d+\.\d+\.\d+$/),
    metricId: z.string().regex(/^[a-z][a-z0-9_]*$/),
    definition: z.string().trim().min(1).max(2000),
    missing: z.array(z.string().trim().min(1)).min(1).max(20),
  })
  .strict();

/** A model can only prepare a proposed revision. It cannot publish or certify it. */
export function proposeMetricChange(input: unknown): {
  base: { version: string; digest: string };
  candidate: Ontology;
  candidateDigest: string;
  changes: string[];
} {
  const proposal = proposalSchema.parse(input);
  const base = resolveReceipt(proposal.base);
  const candidateParts = proposal.candidateVersion.split(".").map(BigInt);
  const baseParts = base.version.split(".").map(BigInt);
  const firstDifference = candidateParts.findIndex((part, index) => part !== baseParts[index]);
  if (firstDifference < 0 || candidateParts[firstDifference]! < baseParts[firstDifference]!) {
    throw new Error("proposal_requires_newer_version");
  }
  const candidate = structuredClone(base);
  const metric = candidate.metrics.find((item) => item.id === proposal.metricId);
  if (!metric) throw new Error("proposal_metric_not_found");
  candidate.version = proposal.candidateVersion;
  metric.version = proposal.candidateVersion;
  metric.definition = proposal.definition;
  metric.missing = proposal.missing;
  metric.origin = "model";
  metric.status = "proposed";
  metric.review = null;
  const valid = validateOntology(candidate);
  return {
    base: proposal.base,
    candidate: valid,
    candidateDigest: ontologyDigest(valid),
    changes: diffOntology(base, valid),
  };
}
