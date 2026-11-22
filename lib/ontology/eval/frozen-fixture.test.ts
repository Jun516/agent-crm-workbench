import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("freezes forty model questions plus four access probes and independent oracles", () => {
  const root = join(process.cwd(), "tests/fixtures/ontology-eval");
  const read = (name: string) => readFileSync(join(root, name));
  const manifest = JSON.parse(read("manifest.json").toString()) as {
    fixture_files_sha256: Record<string, string>;
  };
  for (const [name, digest] of Object.entries(manifest.fixture_files_sha256)) {
    expect(createHash("sha256").update(read(name)).digest("hex"), name).toBe(digest);
  }
  const questions = JSON.parse(read("questions.json").toString()) as {
    cases: Array<{
      id: string;
      question: string;
      oracle: string;
      identity: string;
      entry_expected?: number;
    }>;
  };
  const rubric = JSON.parse(read("rubric.json").toString()) as { rubrics: Record<string, unknown> };
  const sql = JSON.parse(read("sql-expected.json").toString()) as {
    manager: Record<string, unknown>;
    agent: Record<string, unknown>;
  };
  const keys = new Set([
    ...Object.keys(rubric.rubrics),
    ...Object.keys(sql.manager),
    ...Object.keys(sql.agent),
  ]);
  expect(questions.cases).toHaveLength(44);
  expect(questions.cases.filter((item) => item.identity === "manager_a")).toHaveLength(40);
  expect(
    questions.cases
      .filter((item) => item.identity !== "manager_a")
      .every((item) => item.entry_expected === 403),
  ).toBe(true);
  expect(new Set(questions.cases.map((item) => item.id)).size).toBe(44);
  expect(new Set(questions.cases.map((item) => item.question)).size).toBe(44);
  expect(questions.cases.filter((item) => !keys.has(item.oracle))).toEqual([]);
});
