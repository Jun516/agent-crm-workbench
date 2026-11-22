import { getOntology, ontologyDigest } from "./versions";

/** Busca somente termos literais do snapshot publicado. Correspondência não é autorização. */
export function resolveTerms(question: string, version = "1.0.0") {
  if (typeof question !== "string" || question.length === 0 || question.length > 2000)
    throw new Error("invalid_question");
  const catalog = getOntology(version);
  const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("pt-BR");
  const words = (text: string) => normalize(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  const tokens = words(question);
  const matches = (term: string) => {
    const needle = words(term);
    return (
      needle.length > 0 &&
      tokens.some((_, i) =>
        needle.every(
          (word, j) =>
            tokens[i + j] === word || (/[aeiouáéíóú]$/u.test(word) && tokens[i + j] === `${word}s`),
        ),
      )
    );
  };
  // Reviewed aliases from the audit; they identify concepts, not certifications.
  const metricAliases: Record<string, string[]> = {
    high_value: ["alto valor"],
    valid_follow_up: ["follow-up válido", "acompanhamento válido"],
    stagnation: ["estagnação"],
    conversion: ["conversão"],
    opportunity_value: ["valor do negócio"],
  };
  const concepts = [
    ...catalog.entities.map((entity) => ({
      id: entity.id,
      kind: "entity" as const,
      status: "verified" as const,
      terms: [entity.id, ...entity.aliases],
      source: entity.source,
    })),
    ...catalog.metrics.map((metric) => ({
      id: metric.id,
      kind: "metric" as const,
      status: metric.status,
      terms: [metric.id, ...metric.aliases, ...(metricAliases[metric.id] ?? [])],
      source: metric.source,
    })),
  ];
  return {
    version: catalog.version,
    digest: ontologyDigest(catalog),
    candidates: concepts.filter((concept) => concept.terms.some(matches)),
  };
}
