import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const container = "supabase_db_ontology-eval-36";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export function verifyManifest(root: string) {
  const dir = join(root, "tests/fixtures/ontology-eval");
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    seed: number;
    fixture_files_sha256: Record<string, string>;
  };
  if (manifest.seed !== 36) throw new Error("fixture_seed_mismatch");
  const names = [
    "questions.json",
    "seed.sql",
    "oracle.sql",
    "sql-expected.json",
    "rubric.json",
    "negative-controls.sql",
  ];
  if (
    Object.keys(manifest.fixture_files_sha256).length !== names.length ||
    names.some((name) => !(name in manifest.fixture_files_sha256))
  )
    throw new Error("fixture_manifest_incomplete");
  for (const [name, expected] of Object.entries(manifest.fixture_files_sha256)) {
    if (
      !/^[a-z0-9-]+\.(json|sql)$/.test(name) ||
      digest(readFileSync(join(dir, name))) !== expected
    )
      throw new Error("fixture_hash_mismatch");
  }
  return { dir, manifest, manifestSha256: digest(manifestBytes) };
}

/** Read-only local preflight. Oracle data stay inside this process, never in model input. */
export function verifyFixture(root: string) {
  const { dir, manifest, manifestSha256 } = verifyManifest(root);
  const binding = execFileSync("docker", ["port", container, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  if (binding !== "127.0.0.1:55322") throw new Error("fixture_database_not_isolated");
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: readFileSync(join(dir, "oracle.sql")), encoding: "utf8" },
  );
  const rows = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const expected = JSON.parse(readFileSync(join(dir, "sql-expected.json"), "utf8"));
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  if (rows.length !== 2 || canonical({ manager: rows[0], agent: rows[1] }) !== canonical(expected))
    throw new Error("fixture_oracle_mismatch");
  const countsSql = `select json_build_object('pipelines',(select count(*) from crm_pipelines where id::text like '36000001-%'),'stages',(select count(*) from crm_stages where id::text like '36000002-%'),'contacts',(select count(*) from contacts where id::text like '36000003-%'),'leads',(select count(*) from crm_leads where id::text like '36000004-%'),'activities',(select count(*) from crm_lead_activities where id::text like '36000005-%'),'tasks',(select count(*) from crm_tasks where id::text like '36000006-%'))`;
  const counts = JSON.parse(
    execFileSync(
      "docker",
      ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-Atc", countsSql],
      { encoding: "utf8" },
    ),
  );
  const expectedCounts = {
    pipelines: 3,
    stages: 3,
    contacts: 3,
    leads: 8,
    activities: 3,
    tasks: 2,
  };
  if (canonical(counts) !== canonical(expectedCounts))
    throw new Error("fixture_cardinality_mismatch");
  const snapshotSql = readFileSync(join(root, "scripts/ontology-eval-snapshot.sql"));
  const snapshotSqlSha256 = digest(snapshotSql);
  if (snapshotSqlSha256 !== "9dc0c61915da243f9c730d1377e47f8970a1cc301e351f37f2104f8712cd3716")
    throw new Error("fixture_snapshot_query_mismatch");
  const snapshotOutput = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: snapshotSql, encoding: "utf8" },
  );
  const snapshotSha256 = digest(Buffer.from(canonical(JSON.parse(snapshotOutput))));
  if (snapshotSha256 !== "a728ea0bc543727b26ec64a79fd867567de3e21a45f02695d86f58eef4e41587")
    throw new Error("fixture_snapshot_mismatch");
  return {
    manifestSha256,
    oracleSha256: manifest.fixture_files_sha256["oracle.sql"],
    counts,
    oracleMatches: true,
    snapshotSqlSha256,
    snapshotSha256,
  };
}
