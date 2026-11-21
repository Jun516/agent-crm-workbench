import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const alias = z.string().trim().min(1);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const source = z.object({ path: z.string().min(1), detail: z.string().min(1) }).strict();
const field = z
  .object({ name: id, sensitivity: z.enum(["internal", "personal", "sensitive"]), source })
  .strict();
const entity = z
  .object({
    id,
    description: z.string().min(1),
    aliases: z.array(alias),
    table: id,
    fields: z.array(field).min(1),
    source,
  })
  .strict();
const relation = z
  .object({
    id,
    from: id,
    to: id,
    fromField: id,
    toField: id,
    cardinality: z.enum(["many_to_one", "one_to_many"]),
    nullable: z.boolean(),
    source,
    visibility: z.string().min(1),
    ambiguity: z.string().min(1),
  })
  .strict();
const review = z
  .object({
    reviewer: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    evidence: z.string().min(1),
    definitionVersion: version,
  })
  .strict();
const metric = z
  .object({
    id,
    aliases: z.array(alias),
    definition: z.string().min(1),
    status: z.enum(["proposed", "unanswerable", "certified"]),
    origin: z.enum(["human", "model"]),
    review: review.nullable(),
    version,
    entity: id,
    fields: z.array(id),
    dependsOn: z.array(id),
    aggregation: z.string().min(1),
    dateField: id.nullable(),
    timezone: z.string().min(1),
    currency: z.string().min(1),
    scope: z.string().min(1),
    missing: z.array(z.string()),
    source,
  })
  .strict();
const action = z
  .object({
    id,
    capability: id,
    service: z.string().min(1),
    risk: z.enum(["read", "write", "external"]),
    prerequisites: z.array(z.string().min(1)).min(1),
    source,
  })
  .strict();
export const ontologySchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    version,
    entities: z.array(entity).min(1),
    relations: z.array(relation),
    metrics: z.array(metric),
    actions: z.array(action),
  })
  .strict();
export type Ontology = z.infer<typeof ontologySchema>;

// Whitelist transcrita da auditoria #31, não aceita campos arbitrários da entrada.
export const physicalFields: Record<string, readonly string[]> = {
  contacts: ["id", "organization_id", "is_merged_into", "is_anonymized"],
  crm_leads: [
    "id",
    "organization_id",
    "contact_id",
    "status",
    "value_cents",
    "currency",
    "created_at",
    "last_activity_at",
    "closed_at",
  ],
  conversations: ["id", "organization_id", "contact_id", "is_group"],
  crm_lead_activities: ["id", "organization_id", "lead_id", "contact_id", "performed_at", "type"],
  crm_tasks: ["id", "organization_id", "lead_id", "contact_id", "due_date", "status"],
};
const physicalRelations: Record<string, boolean> = {
  "crm_leads.contact_id:contacts.id": true,
  "conversations.contact_id:contacts.id": false,
  "crm_lead_activities.lead_id:crm_leads.id": false,
  "crm_lead_activities.contact_id:contacts.id": true,
  "crm_tasks.lead_id:crm_leads.id": true,
  "crm_tasks.contact_id:contacts.id": true,
};

// Referências explicitamente revisadas; não concede autorização nem executa ferramentas.
export const allowedActions = [
  { capability: "crm_update_lead", service: "app/api/v1/leads/_handler.ts", risk: "write" },
] as const;

/** Valida forma e referências; não é autorização nem verificação de dados em runtime. */
export function validateOntology(input: unknown): Ontology {
  const catalog = ontologySchema.parse(input);
  const errors: string[] = [];
  const unique = (items: string[], label: string) => {
    if (new Set(items).size !== items.length) errors.push(`duplicate ${label}`);
  };
  unique(
    catalog.entities.map((x) => x.id),
    "entity",
  );
  unique(
    catalog.relations.map((x) => x.id),
    "relation",
  );
  unique(
    catalog.metrics.map((x) => x.id),
    "metric",
  );
  unique(
    catalog.actions.map((x) => x.id),
    "action",
  );
  unique(
    [...catalog.entities, ...catalog.metrics].map((x) => x.id),
    "concept id",
  );
  const entities = new Map(catalog.entities.map((x) => [x.id, x]));
  const terms = new Map<string, string>();
  for (const item of [...catalog.entities, ...catalog.metrics]) {
    for (const term of [item.id, ...item.aliases]) {
      const key = term.trim().toLocaleLowerCase("pt-BR");
      const owner = terms.get(key);
      if (owner && owner !== item.id) errors.push(`term conflict: ${key}`);
      else terms.set(key, item.id);
    }
  }
  for (const e of catalog.entities) {
    unique(
      e.fields.map((f) => f.name),
      `field in ${e.id}`,
    );
    for (const f of e.fields)
      if (!physicalFields[e.table]?.includes(f.name))
        errors.push(`invalid field: ${e.table}.${f.name}`);
    if (!e.fields.some((f) => f.name === "organization_id"))
      errors.push(`missing organization: ${e.id}`);
  }
  for (const r of catalog.relations) {
    const from = entities.get(r.from),
      to = entities.get(r.to);
    if (
      !from ||
      !to ||
      !from.fields.some((f) => f.name === r.fromField) ||
      !to.fields.some((f) => f.name === r.toField)
    ) {
      errors.push(`invalid relation: ${r.id}`);
      continue;
    }
    const fk =
      r.cardinality === "many_to_one"
        ? `${from.table}.${r.fromField}:${to.table}.${r.toField}`
        : `${to.table}.${r.toField}:${from.table}.${r.fromField}`;
    if (!(fk in physicalRelations) || physicalRelations[fk] !== r.nullable)
      errors.push(`unverified relation: ${r.id}`);
  }
  const metrics = new Map(catalog.metrics.map((x) => [x.id, x]));
  for (const m of catalog.metrics) {
    const e = entities.get(m.entity);
    if (
      !e ||
      m.fields.some((f) => !e.fields.some((ef) => ef.name === f)) ||
      (m.dateField !== null && !m.fields.includes(m.dateField))
    )
      errors.push(`invalid metric fields: ${m.id}`);
    if (m.dependsOn.some((d) => !metrics.has(d))) errors.push(`unknown dependency: ${m.id}`);
    if (m.status === "certified" && m.dependsOn.some((d) => metrics.get(d)?.status !== "certified"))
      errors.push(`uncertified dependency: ${m.id}`);
    if (m.origin === "model" && m.status !== "proposed")
      errors.push(`model draft must be proposed: ${m.id}`);
    if (
      m.status === "certified" &&
      (m.origin !== "human" ||
        !m.review ||
        m.review.definitionVersion !== m.version ||
        m.missing.length > 0)
    )
      errors.push(`invalid certification: ${m.id}`);
  }
  for (const action of catalog.actions) {
    const binding = allowedActions.find((entry) => entry.capability === action.capability);
    if (!binding || binding.service !== action.service || binding.risk !== action.risk)
      errors.push(`unverified action: ${action.id}`);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) {
      errors.push(`metric cycle: ${key}`);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const d of metrics.get(key)?.dependsOn ?? []) if (metrics.has(d)) visit(d);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of metrics.keys()) visit(key);
  if (errors.length) throw new Error(errors.join("; "));
  return catalog;
}
