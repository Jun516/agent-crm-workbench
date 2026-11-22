import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyManifest } from "./verify-fixture";

it("rejects a changed frozen oracle and an incomplete manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ontology-manifest-"));
  const target = join(root, "tests/fixtures/ontology-eval");
  try {
    cpSync(join(process.cwd(), "tests/fixtures/ontology-eval"), target, { recursive: true });
    expect(verifyManifest(root).manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(target, "oracle.sql"), "select 1;\n");
    expect(() => verifyManifest(root)).toThrow("fixture_hash_mismatch");
    writeFileSync(
      join(target, "manifest.json"),
      JSON.stringify({ seed: 36, fixture_files_sha256: {} }),
    );
    expect(() => verifyManifest(root)).toThrow("fixture_manifest_incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
