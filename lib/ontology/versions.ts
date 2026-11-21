import { createHash } from "node:crypto";
import { validateOntology, type Ontology } from "./contract";
import snapshotV1 from "./snapshot-v1.json";

// Canonicalização ordena chaves, preservando a ordem semântica de arrays.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function ontologyDigest(catalog: Ontology): string {
  return createHash("sha256")
    .update(canonical(validateOntology(catalog)))
    .digest("hex");
}
export function ontologySnapshot(catalog: Ontology) {
  const valid = validateOntology(catalog);
  return {
    version: valid.version,
    contractVersion: valid.contractVersion,
    digest: ontologyDigest(valid),
    catalog: valid,
  };
}
export function diffOntology(before: Ontology, after: Ontology): string[] {
  const a = JSON.parse(canonical(validateOntology(before))),
    b = JSON.parse(canonical(validateOntology(after)));
  const changes: string[] = [];
  function walk(x: unknown, y: unknown, path: string) {
    if (canonical(x) === canonical(y)) return;
    if (
      x &&
      y &&
      typeof x === "object" &&
      typeof y === "object" &&
      !Array.isArray(x) &&
      !Array.isArray(y)
    ) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
        );
    } else changes.push(path);
  }
  walk(a, b, "");
  return changes.sort();
}
// Versões publicadas devem permanecer imutáveis e disponíveis para recibos antigos.
const versions = { "1.0.0": snapshotV1 } as const;
export function getOntology(version: string): Ontology {
  const snapshot = versions[version as keyof typeof versions];
  if (!snapshot) throw new Error(`Unknown ontology version: ${version}`);
  const catalog = validateOntology(structuredClone(snapshot.catalog));
  if (catalog.version !== version || ontologyDigest(catalog) !== snapshot.digest)
    throw new Error("Published ontology snapshot mismatch");
  return catalog;
}
export function resolveReceipt(ref: { version: string; digest: string }): Ontology {
  const catalog = getOntology(ref.version);
  if (ontologyDigest(catalog) !== ref.digest) throw new Error("Ontology receipt digest mismatch");
  return catalog;
}
/** Inclui escopo e revisão de configuração vindos do chamador confiável, nunca identidade de modelo. */
export function ontologyCacheKey(
  catalog: Ontology,
  scopeKey: string,
  configRevision: string,
): string {
  if (!scopeKey || !configRevision) throw new Error("scope and config revision required");
  return createHash("sha256")
    .update(canonical([catalog.version, ontologyDigest(catalog), scopeKey, configRevision]))
    .digest("hex");
}
