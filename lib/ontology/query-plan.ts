import { createHash } from "node:crypto";
import { z } from "zod";
import { getOntology, ontologyDigest } from "./versions";
import { resolveTerms } from "./resolve-terms";

const common = {
  ontologyVersion: z.literal("1.0.0"),
  ontologyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.literal(100),
};
const criteriaSchema = z
  .object({
    minimumValueCents: z.number().int().nonnegative().max(2_147_483_647),
    currency: z.string().regex(/^[A-Z]{3}$/),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    activityTypes: z
      .array(z.enum(["appointment_completed", "voice_call", "task_completed"]))
      .min(1)
      .max(3),
  })
  .strict()
  .refine(
    (x) =>
      Date.parse(x.to) > Date.parse(x.from) &&
      Date.parse(x.to) - Date.parse(x.from) <= 366 * 86400000,
  );
const planSchema = z.discriminatedUnion("template", [
  z.object({ ...common, template: z.literal("open_opportunities_v1") }).strict(),
  z.object({ ...common, template: z.literal("tasks_without_due_v1") }).strict(),
  z
    .object({
      ...common,
      template: z.literal("explicit_activity_gap_v1"),
      criteria: criteriaSchema,
    })
    .strict(),
]);
export type ReadPlan = z.infer<typeof planSchema>;

/** Explicit criteria are an assumption supplied by the caller, not certified follow-up. */
export function planExplicitActivityGap(criteria: unknown): ReadPlan {
  const catalog = getOntology("1.0.0");
  const parsed = criteriaSchema.safeParse(criteria);
  if (!parsed.success) throw new Error("ontology_invalid_criteria");
  return {
    ontologyVersion: "1.0.0",
    ontologyDigest: ontologyDigest(catalog),
    limit: 100,
    template: "explicit_activity_gap_v1",
    criteria: parsed.data,
  };
}

/** Only whole, reviewed phrasings map to a template; partial matches cannot drop filters. */
const openQuestion =
  /^(?:quais|liste|listar) (?:os |as )?(?:negocios|oportunidades) (?:estao )?abert(?:os|as)\??$/;
const tasksQuestion = /^(?:quais|liste|listar) (?:as )?tarefas (?:nao tem prazo|sem prazo)\??$/;
function normalize(question: string) {
  return question
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim()
    .replace(/\s+/g, " ");
}
export function checkAnswerable(question: string) {
  const terms = resolveTerms(question);
  if (openQuestion.test(normalize(question)) || tasksQuestion.test(normalize(question)))
    return { status: "supported" as const, missing: [], terms };
  const normalized = normalize(question);
  const missing: string[] = [];
  if (/alto valor|alta valor|high_value/.test(normalized))
    missing.push("Limiar, moeda, âmbito e período de alto valor não foram certificados.");
  if (/follow.?up|acompanhamento|seguimento/.test(normalized))
    missing.push(
      "Follow-up válido exige definição certificada de canal, direção, entrega, ator e janela.",
    );
  if (/lucro|profit|margem/.test(normalized))
    missing.push("Custo e definição de lucro não estão disponíveis no catálogo.");
  if (/conversao|conversion/.test(normalized))
    missing.push("Conversão exige coorte, denominador, período e histórico certificados.");
  if (!missing.length)
    missing.push(
      "A pergunta não corresponde a uma consulta certificada; esclareça filtros e definições de negócio.",
    );
  return { status: "unsupported" as const, missing, terms };
}
export function planQuery(question: string): ReadPlan | null {
  if (checkAnswerable(question).status !== "supported") return null;
  const catalog = getOntology("1.0.0");
  return {
    ontologyVersion: catalog.version as "1.0.0",
    ontologyDigest: ontologyDigest(catalog),
    template: tasksQuestion.test(normalize(question))
      ? "tasks_without_due_v1"
      : "open_opportunities_v1",
    limit: 100,
  };
}
export function validateReadPlan(input: unknown): ReadPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new Error("ontology_invalid_plan");
  const plan = parsed.data;
  if (ontologyDigest(getOntology(plan.ontologyVersion)) !== plan.ontologyDigest)
    throw new Error("invalid_plan_version");
  return plan;
}
export function planHash(input: unknown): string {
  const p = validateReadPlan(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        p.ontologyVersion,
        p.ontologyDigest,
        p.template,
        p.limit,
        p.template === "explicit_activity_gap_v1"
          ? [
              p.criteria.minimumValueCents,
              p.criteria.currency,
              p.criteria.from,
              p.criteria.to,
              p.criteria.activityTypes,
            ]
          : null,
      ]),
    )
    .digest("hex");
}
