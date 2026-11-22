/** A deterministic regression gate for memory-recall changes, including RSI proposals.
 * Never invokes an external model or promotes a candidate. Docker is required. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const directory = path.join(root, "tmp", "customer-memory-regression", runId);
mkdirSync(directory, { recursive: true });
const cases = [
  {
    name: "policy-and-evaluation",
    args: [
      "exec",
      "vitest",
      "run",
      "lib/ai/customer-memory/policy.test.ts",
      "lib/ai/customer-memory/recall.test.ts",
      "lib/ai/evals/memory-coverage.test.ts",
      "lib/ai/evals/memory-policy.test.ts",
      "lib/agent-engine/agent/followup-memory.test.ts",
    ],
  },
  {
    name: "sql-trust-and-consumption",
    args: [
      "test:db",
      "tests/invariants/customer-memory-lifecycle.test.ts",
      "tests/invariants/customer-memory-semantic-recall.test.ts",
      "tests/invariants/customer-memory-consumption.test.ts",
      "tests/invariants/customer-memory-followup-timing.test.ts",
      "tests/invariants/customer-memory-metrics.test.ts",
      "tests/invariants/customer-memory-activity.test.ts",
      "tests/invariants/customer-memory-automation.test.ts",
      "tests/invariants/ai-service-integrations.test.ts",
      "tests/invariants/ai-memory-privacy-acceptance.test.ts",
    ],
  },
];
const checks = cases.map((item) => {
  const log = path.join(directory, `${item.name}.log`),
    report = path.join(directory, `${item.name}.json`);
  const fd = openSync(log, "w");
  const started = Date.now();
  const result = spawnSync("pnpm", [...item.args, "--reporter=json", `--outputFile=${report}`], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", fd, fd],
    timeout: 20 * 60 * 1000,
  });
  closeSync(fd);
  let counts: { passed: number; failed: number; skipped: number; total: number } | null = null;
  try {
    const data = JSON.parse(readFileSync(report, "utf8"));
    if (
      [data.numPassedTests, data.numFailedTests, data.numPendingTests, data.numTotalTests].every(
        (n) => typeof n === "number",
      )
    )
      counts = {
        passed: data.numPassedTests,
        failed: data.numFailedTests,
        skipped: data.numPendingTests,
        total: data.numTotalTests,
      };
  } catch {
    /* A missing report is inconclusive, never a green check. */
  }
  const verdict =
    result.status === 0 && counts && counts.total > 0 && counts.passed > 0 && counts.failed === 0
      ? "pass"
      : result.error || result.status === 0
        ? "inconclusive"
        : "fail";
  return {
    name: item.name,
    verdict,
    exit_code: result.status,
    signal: result.signal,
    elapsed_ms: Date.now() - started,
    counts,
    log: path.relative(root, log),
    report: path.relative(root, report),
  };
});
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const state = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const summary = {
  schema_version: 1,
  regression: "customer-memory-policy-v1",
  as_of: new Date().toISOString(),
  git_commit: git.status === 0 ? git.stdout.trim() : null,
  working_tree_dirty: state.status === 0 ? Boolean(state.stdout.trim()) : null,
  verdict: checks.every((c) => c.verdict === "pass")
    ? "pass"
    : checks.some((c) => c.verdict === "fail")
      ? "fail"
      : "inconclusive",
  scope:
    "Deterministic SQL trust, recall, native consumption, expiry, locks, candidate isolation, privacy and metrics. Natural-language adoption and live-provider behavior are not measured.",
  checks,
};
writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(
  JSON.stringify(
    { ...summary, artifact: path.relative(root, path.join(directory, "summary.json")) },
    null,
    2,
  ) + "\n",
);
process.exitCode = summary.verdict === "pass" ? 0 : summary.verdict === "fail" ? 1 : 2;
