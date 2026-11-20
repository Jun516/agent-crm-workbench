# Customer memory loop — issue 28

The validation history below describes upstream runs. Captures and raw evidence stay in the upstream reference archive. See the [evidence publication policy](../../evidence/README.md).

Scope: the complete P0–P3 contract in https://github.com/helsome/AiNativeCrm/issues/28.
Destination: core. Confirmed SQL memory, human confirmation, privacy, and runtime safety must work with zero optional integrations. Mem0 remains an optional L1 projection/ranker, never a source of facts. L2 is local only.

## Acceptance worklist

- [x] SQL L1 lifecycle: subtype/risk, TTL, locks, review, explicit replacement lineage.
- [x] Revalidate SQL/contact after remote search; valid locked constraints survive search misses; return honest coverage/status/provenance.
- [x] L0 business context wins; flag affected L1 for review. L3 remains service-scoped; L4 stays separate.
- [x] Close/task/checkpoint triggers extract evidence-backed L2 through the existing model gateway. No automatic promotion.
- [x] Report footer confirmation cards and contact queue: confirm/rewrite/reject, dedupe, conflicts, lock/unlock, explicit remember.
- [x] Owner confirmation / colleague proposals / manager arbitration; transfer follows current ownership.
- [x] Nightly dedupe/clustering/expiry/conflict maintenance, no locked confirmed-body rewrite/delete.
- [x] Used-memory receipts visible with evidence links; correction feedback closes the review loop.
- [x] Metrics and memory-policy eval/RSI regressions.
- [x] Migration + baseline + MANIFEST + generated types; real RLS/privacy/update tests.
- [x] Required typecheck/lint/unit/build, real frontend acceptance, release fragment and architecture/journey documentation; full-run exceptions reconciled explicitly below, with current-delta verification.


## Current evidence summary

Product source is `1548b3d6`; `988493a5` only completes the new queued-turn test fixture's
static types. PR [#29](https://github.com/helsome/AiNativeCrm/pull/29) contains the implementation.
This section and the acceptance worklist describe final verification. Dated checkpoints below
retain intermediate states; their pending-work notes are superseded by this summary.

| Check | Measured result |
| --- | --- |
| Frozen memory policy/SQL regression | Clean `988493a5`: 27 unit + 82 real pg15 DB passed, zero failures/skips; `tmp/customer-memory-regression/2026-11-12T20-32-13-222Z-e390a999/summary.json`. |
| Follow-up timing integration | Actual queued-turn caller, native provider context and SQL receipt; 4 files / 35 cases pass with engine, bridge and service-boundary regressions. The origin conversation is preserved when another is newer. |
| Runtime regression | 54 passed across 5 unit files; 1 existing live OpenCode-provider case skipped for its optional key. All new deterministic memory cases ran. |
| Production and browser | Product-source rebuild exit 0; all 4 Chromium flows pass (44.0s), including unavailable extraction, source permissions, pagination, correction and HTTP-safe audited retry. |
| Typecheck and lint | Final typecheck exit 0; earlier full lint at `4778d18f` had 0 errors / 477 existing warnings, and all current changed source/test files pass scoped ESLint. |
| Post-commit timing negative controls | Removing memory scope, original conversation binding or refresh-error propagation triggers exactly 4/4, 1/4 or 2/4 DB failures. Restoration passes 4/4; temporary worktree removed. |
| HTTP retry negative control | 9 unit passed; restoring the raw UUID call causes exactly 2/9 failures, restoration 9/9. Current browser still covers actual POST/SQL/audit with randomUUID absent. |
| Whole pg15 DB (historical complete run) | 274 then-existing files: 2313 normal passes, 1 source-scan timeout, 1 expected failure and 1 skip. Unchanged scan/worker recheck 9/9 at 120s. Current backend delta is covered by the fresh memory gate and follow-up regression. |
| Data-bearing update | Exit 0; ten seeded rows and view identity retained. New memory jobs, usage receipt and candidates also survive baseline reapplication. |
| Whole unit (historical diagnostic) | 1348 files: 13150 normal passes, 21 failures, 1 expected failure, 1 skip and 3 unhandled errors. Two failures repaired, eleven pass unchanged-assertion rechecks, eight independently reproduce on origin/main. Both omitted worker files pass their separate 21-case recheck. |
| Changed-file accounting | All 21 changed unit test files appear in original or current-delta reports. All original 274 DB files ran under the unchanged include; the new timing file is in the fresh 82-case DB gate. |
| Release and architecture | Release fragment and current migration collision checks pass. Existing channel/role-rank checks pass. Architecture JSON has valid node references and both real timing edges; full rendering remains limited by the documented archify schema mismatch. |

The original full-repository runs remain non-green. Existing workflow-trigger, release-guard,
theme and upload-fixture failures are retained rather than hidden or repaired outside this issue.
No paused workflow was reactivated. Raw local receipts are under ignored `tmp/memory-28/`;
the public machine-readable reconciliation is validation summary.
Optional live Mem0/models and natural-language decision quality were not measured. SQL/Auth,
actual native deterministic-provider requests and Chromium user flows were measured.

## Decisions and boundaries

CONFIRMED by issue: unconfirmed candidates never enter factual model context; ephemeral memory requires expiration; durable facts may have a review date; replacement is explicit; locked facts cannot be modified by consolidation. Existing unknown-write reconciliation and remote-cleanup receipts remain authoritative.

INFERRED implementation choice, pending product feedback: ownership will resolve from current assigned conversations or related CRM lead owners, since contacts do not have a canonical owner field. A manager can arbitrate; colleagues can propose. Do not silently use contact creator as owner. Confirmation and lock actions must recheck current membership/assignment inside the write transaction.

Account-wide inheritance and deal-scoped subjects are explicitly deferred by the issue. Contact memory can still expire at a chosen timestamp; no second account-memory authority is introduced.

## Evidence required for completion

For every checkbox, record actual implementation paths and command/runtime receipts here. A green narrow policy test does not prove completion of the issue. UI, async extraction, privacy and database tests remain required.

## Implementation checkpoint — 2026-11-12

The first implementation slice adds `policy.ts`, policy-aware `readConfirmedCustomerMemory`, idempotent policy metadata and explicit unlocked replacement through `saveCustomerMemory`, plus migration 0409 and its baseline/MANIFEST entries. L2/evidence/conflict/usage tables are present, but their producers and sales UI are not yet connected; this is not completion of P0–P3.

Evidence: targeted memory unit tests passed (28 cases across policy, SQL recall, existing integration and independent coverage tests). The self-host pg15 harness applied install/update and passed 103 cases across lifecycle, existing Mem0/privacy, RLS completeness and privacy-cascade suites. A later baseline ordering repair moved the new block before the final anon sweep; that ordering guard and MANIFEST guard passed (13 cases); rerun database acceptance after this repair before final completion.

Types were generated using Supabase CLI / postgres-meta from a fresh disposable pg15 database with the CI prelude and baseline. Only the changed memory tables were reconciled automatically from the generated AST into `lib/database.types.ts`, retaining unrelated schemas and existing view contracts. No column types were hand-authored. Temporary generation artifacts are in ignored `tmp/memory-28/`.

Current typecheck passed after scoped generation. Lint exited 0 with existing repository warnings. A diagnostic full unit run was started while implementation was ongoing and was later interrupted (exit 130), so it is not final acceptance; it has exposed workflow assertions against the upstream paused Actions configuration as well as the baseline-ordering test fixed above. No all-suite green claim is made. Before final completion, distinguish baseline failures, rerun all gates on the finished implementation, and perform the real frontend acceptance.

## Candidate decision checkpoint

`candidates.ts` / `authority.ts` and `/api/v1/ai/customer-memory/candidates` now implement proposals, evidence validation, dedupe, explicit rejection cooldown, human rewrite/confirm, manager-only conflict replacement, manual merge, optimistic decision tokens and transfer/revocation checks. Candidate bodies are never passed to `readConfirmedCustomerMemory`. Candidate source quotes are additionally checked through the browser session RLS client before API reads or evidence-backed proposals.

Ownership fallback for this implementation: the most recently assigned non-group conversation, or a currently open user-owned CRM lead. Old historical conversation assignments do not grant confirmation authority. Managers arbitrate conflicts. This is the documented fallback for the product question above, not a new contact-owner column. Rejection cooldown is chosen explicitly by the reviewer rather than inventing a silent business default.

Evidence: the candidate real-database suite passed eight cases, including exact inbound evidence, L2-not-L1, owner transfer, rejected-signal suppression, current role revocation, locked conflict replacement, merge evidence, and stale decision tokens. Separate route tests cover trusted org/actor, read-only support, and private evidence filtering. Report UI and automatic extraction/maintenance remain outstanding.

Living System Checklist (backend checkpoint, not final DoD):

1. Input: explicit proposal route; automatic producers still pending.
2. Output: candidate decision to existing `saveCustomerMemory`; SQL recall to CRM tool/L3 context.
3. Record: registered proposal/decision audit actions; source evidence and decision receipts.
4. Screen: contact panel and report cards still pending.
5. Door: existing contact/workbench routes; frontend wiring still pending.
6. Anti-death: pending queue and optimistic conflict response; nightly handling still pending.
7. Configuration: reviewer explicitly chooses expiry and rejection deadline; lock UI still pending.
8. Continuity: machine hypotheses remain L2; current human authority produces L1.
9. Return loop: rejection suppresses the same fingerprint; usage correction/metrics still pending.
10. Map: `chat-first-runtime-parity.architecture.json` now connects candidate decisions, SQL truth, selection and checkpoint context. No HTML re-render.

## Verification and local runtime checkpoint

- Current targeted unit suite: 35/35 passed, exit 0.
- Latest lifecycle/privacy/security DB batch: 117/117 passed, exit 0, pg15 baseline install and update.
- Candidate workflow DB batch: 8/8 passed, exit 0.
- Negative control performed after the implementation commit: removing locked selection caused exactly the two predicted policy tests to fail (locked search-miss coverage and locked-budget failure). Restoring the implementation returned the targeted suite to green. Receipts are local `AiNativeCrm-memory-28-sabotage.log` and `AiNativeCrm-memory-28-focused.log` in the parent directory.
- Current typecheck: exit 0. Lint: exit 0, 476 existing warnings; no additional warning count.
- The full-suite diagnostic exposed paused-workflow assertions and some scan timeouts; it was stopped because the worktree had changed during execution. Final all-suite validation must run against the finished, fixed tree.
- A separate real Supabase pg15 project `crm-memory-28` is running on API 54421 / DB 54422. Current baseline applied with zero SQL errors after the normal extension bootstrap. `bootstrap-owner.ts` created one synthetic owner and organization. Dedicated Redis REST returned PONG. No UI server or browser acceptance has run yet.
- Local test configuration is ignored at `tmp/memory-28/app.env`; service discovery is `tmp/memory-28/local-stack-status.json`. Do not print or commit their values. Existing user/demo stacks were retained.

Next required work remains the report/contact confirmation UI, lifecycle lock/review actions, event-triggered extraction through the existing model gateway, nightly maintenance with L0 reconciliation, task-time injection/usage/correction receipts, metrics/eval extensions, then complete database/UI/build/full-suite verification. The issue stays open and the goal stays active.

## Event, maintenance and human-review checkpoint

Migration 0410 adds durable close/checkpoint/task/business producers and tenant-local 02:00 maintenance, consumed by `customer-memory/jobs.ts` and the existing worker. Extraction uses the canonical model gateway with a bounded, in-memory review tool; exact inbound excerpts produce only L2. Missing model configuration is recorded as unavailable, never fabricated success. Source scope, contact privacy, observed L0/L1 revisions and the exact job lease are rechecked before writes. Nightly maintenance expires unlocked temporary memories while preserving unknown-write cleanup receipts, flags durable review dates, conservatively merges exact duplicates with their evidence and queues conflict review without automatic promotion.

`lifecycle.ts` and its API now support owner/manager lock/unlock, review and retirement with `policy_revision` checks. Only managers arbitrate L0/L1 and L1/L1 conflicts. Neither arbitration nor retirement silently unlocks a memory. L0 source fingerprints are revalidated; business rows are never edited. A decision to keep both facts requires a human explanation, exposed as `review_note` in recall. Soft-revoked membership is rejected inside the transaction, in addition to the route guard.

`CustomerMemoryCandidates.tsx` is connected beneath the selected workbench report, and `CustomerMemoryPanel.tsx` is available to agents from the contact dossier. The report deliberately shows the contact's current shared queue, explicitly including older suggestions: deduplicated signals must remain reviewable even when originally proposed in an earlier run. Cards expose evidence, timestamp, risk and confidence, plus rewrite/confirm/reject and an explicitly chosen rejection deadline. Contact UI adds explicit remember, locks, review, replacement links, merge and manager conflicts; synchronization/cleanup controls are collapsed. Automatic hypotheses derived from any inaccessible source are hidden entirely, including when their displayed quote window omits that source. New workbench runs persist the resolved contact/pipeline scope so completion events have an authoritative subject.

Measured against this checkpoint:

- Targeted UI/domain/route suite: 8 files, 48 tests, exit 0 (`AiNativeCrm-memory-28-ui-unit.log`).
- Database install + reapplication + selected lifecycle/candidate/privacy/RLS/hardening regression: 8 files, 139 tests, exit 0 (`AiNativeCrm-memory-28-regression-db.log`), including 20 automation/human-lifecycle cases. These are selected suites, not the entire database suite.
- Typecheck and scoped ESLint: exit 0. Production `pnpm build`: exit 0, using an environment-injecting wrapper; passing Node `--env-file` directly to Next had failed because worker `NODE_OPTIONS` rejects that argument.
- Real Playwright frontend path passed on the fresh Supabase project with local WAHA/Redis and the bootstrap owner: report rewrite-confirm and rejection, then contact lock, explicit unlock, retire, reload and SQL verification. Optional model/integration keys were absent. Synthetic inbound messages and a clearly labeled report are fixture prerequisites; this does not claim live-model extraction or onboarding acceptance. Evidence: report candidates, contact locked, contact after retirement; spec `tests/e2e/customer-memory-loop.spec.ts`.
- Architecture JSON now connects the worker to checkpoints, candidates and SQL lifecycle, and report/contact review to human decisions. Its HTML has not been rerendered.

Still required before issue completion: task-time injection for start/resume/inbound/drafts, usage/evidence receipts and correction feedback, metrics and policy eval/RSI regressions, queue/status pagination (including private-source-heavy and >100-memory cases), legacy raw-scope task handling, final all-suite validation and remaining frontend acceptance. Full-unit diagnostics from the earlier checkpoint remain non-green evidence, not superseded by the targeted suite. No full P0–P3 completion claim is made.

Committed implementation checkpoint: `12fa2dff`. After that commit, removing only `and revoked_at is null` from the transactional authority query caused the exact predicted soft-revocation test to fail (one failed, six passed). Restoring the committed source returned the human-lifecycle database suite to seven passed, exit 0. Logs: `AiNativeCrm-memory-28-revocation-sabotage.log` and `AiNativeCrm-memory-28-revocation-restored.log` in the parent directory. Committed blobs and restored source were checked as plaintext; no encrypted workstation header was committed.

## Request context and correction checkpoint — 2026-11-13

`context.ts` refreshes SQL L0 and confirmed L1 immediately before every native Pi request, including workbench start/resume, specialists, inbound and reply previews. It validates contact, run, draft generation and current service/demanda boundary; old reserved context blocks, stale memory-tool envelopes and old-service checkpoints are stripped. Valid locks must fit the context budget or the request fails visibly. Legacy raw conversation/lead scopes are bound to the freshly verified contact while the run is running.

`consumption.ts` records a parent recall and per-memory ID/revision/confirmation metadata only after the native adapter acknowledges that exact context in a successfully completed model step. Prepared-but-unread context creates no receipt. Delayed product callbacks are drained and callback failure is surfaced. A later failed outer call preserves already-consumed steps with an error outcome; no new customer-fact body copy is stored.

`usage.ts` and `/api/v1/ai/customer-memory/usage` resolve the actual report/conversation/current draft generation, filter source links through session RLS and check current membership/privacy. Cursor pagination preserves microsecond timestamps. `CustomerMemoryUsage` appears beside the workbench report and reply draft. Artifact-scoped correction is idempotent: retain the reason and flag only the exact still-current used revision for human review, never rewrite body/lock or reflag a later human revision.

Measured evidence for this checkpoint:

- Database install/update plus consumption/human-lifecycle/RLS selection: 3 files, 97 cases, exit 0 (`AiNativeCrm-memory-28-consumption-current-db.log`). Additional current-draft-generation case: consumption suite 12 cases, exit 0 (`AiNativeCrm-memory-28-consumption-draft-db.log`).
- Targeted component/route/native-runtime suite: 4 files, 39 passed and 1 live-provider test skipped. Separate delayed multi-request/callback-failure regression: 28 passed, 1 skipped. Logs: `AiNativeCrm-memory-28-usage-unit.log`, `AiNativeCrm-memory-28-request-race-unit.log`.
- Typecheck exit 0; full ESLint exit 0 with existing warnings. Production build exit 0 (`AiNativeCrm-memory-28-consumption-build.log`). These checks precede the later baseline/fixture/architecture repairs; final fixed-tree checks still apply.
- Playwright real browser + real SQL path passed, including visible receipt, accessible evidence link, submission of correction and SQL `needs_review` proof. Usage and correction screen. Test acknowledgement/report inputs are explicitly synthetic; native Pi consumption is independently verified by the real-DB faux-provider invariant. No live external model is claimed. The first E2E attempt failed at module import because Playwright uses CJS while Pi faux exports ESM; that native fixture remains in the invariant suite rather than pretending a browser provider ran.
- New queue kinds are consolidated in the baseline's single earlier CHECK block. Repeating old narrower CHECKs at update time would reject existing memory jobs; the separate 0410 migration remains the incremental path.

Architecture maps now connect fresh context → native runtime → SQL receipt → report/draft review → current-version review flag. New memory worker kinds are also nodes in the canonical turn workflow. Destination remains core, optional Mem0 off still works. Synchronization details remain folded; usage source links and usage-read failures are visible. The correction flag closes the human review loop. Background extraction status has a separate visibility gap recorded in the later audit.

Not complete: metrics, expanded policy evaluation and RSI regression integration; candidate/status pagination under private-heavy and >100-memory loads; full fixed-tree unit/database regression and remaining acceptance audit. The ongoing full-unit run is diagnostic and has already exposed structural guards needing repair plus upstream workflow assumptions; it is not all-suite green evidence. The issue and goal remain open.

Follow-up verification after baseline/architecture/fixture repairs: seven structural guard files
passed all 244 cases (`AiNativeCrm-memory-28-consumption-guards-restored.log`). The corrected
baseline was reapplied to the isolated acceptance database with two existing new-kind jobs, one
usage receipt and eight candidates; before/after counts were identical and SQL exited 0. The
first data-update probe had zero queued jobs (events had not been drained), so it was explicitly
rejected as proof; the second seeded future-dated synthetic jobs and proved the intended case.
Current selected DB install/update regression: four files, 111 cases, exit 0
(`AiNativeCrm-memory-28-consumption-final-db.log`). This selection includes consumption,
automation, human lifecycle and RLS completeness; it is not the whole privacy/database suite.

Committed consumption checkpoint: `b3096b20` (45 files). Final typecheck and scoped ESLint
exited 0 (one new set-state-in-effect warning; no lint errors). The rebuilt production app
passed the browser scenario again (`AiNativeCrm-memory-28-consumption-final-e2e.log`), and
production build exited 0 (`AiNativeCrm-memory-28-consumption-final-build.log`).

Negative control after the implementation commit: in a detached disposable worktree, change
`finish` to iterate prepared contexts instead of acknowledged contexts. Exactly the predicted
pre-acknowledgement receipt assertion failed (1 failed, 11 passed). Restore the committed
source: 12 passed, exit 0. A first restore attempt timed out at 20 seconds in the native
fixture during concurrent compilation; it is retained as non-green evidence. The subsequent
restored run after the build passed. Logs: `AiNativeCrm-memory-28-consumption-sabotage.log`,
`AiNativeCrm-memory-28-consumption-sabotage-restored.log`,
`AiNativeCrm-memory-28-consumption-sabotage-restored-after-build.log`. The temporary worktree
was removed after restoration; committed blobs were verified to contain plaintext, not the
workstation encryption header.

The whole-repository `pnpm test:unit` diagnostic remains live (session 88387, process 54932
at this checkpoint; log `AiNativeCrm-memory-28-consumption-full-unit.log`). It began before
the later guard repairs; do not treat its eventual result as a final fixed-tree acceptance.
Poll that exact handle/process to completion, inspect remaining failures and distinguish
upstream paused-workflow assertions from regressions. Do not restart on an observation timeout.
The full P0–P3 checklist above remains open pending the named metrics, evaluation, pagination
and full acceptance work.

## Metrics, evaluation and pagination implementation — 2026-11-13

`metrics.ts` reads one SQL snapshot under current manager authority. The contact panel shows
confirmed/rejected decision rates with their denominator, median confirmation latency and its
sample count, pending candidates older than seven days, open-conflict age and resolved latency,
and corrections per distinct root report / independently generated draft. Repeated model steps
and specialist runs do not inflate document counts. Workbench-derived drafts belong to their
report metric; independent previews belong to the draft metric. Missing samples stay null, not
zero. Anonymous/merged contacts and revoked or non-manager memberships are refused. No body
or source quote is returned by this metrics API.

`evaluation.ts` joins actual SQL consumption receipts to stable historical policy evidence.
The existing workbench evaluation API now loads native memory material from its selected
contact, even without a `crm_get_contact` tool. Missing valid locks, invalid/expired injected
IDs, wrong scope, incorrect metadata and inconsistent receipt counts are deterministic failures.
Task trimming of unrelated preferences and a complete local fallback are valid. Later human
edits are explicitly unverifiable history and require review; they do not become invented past
violations. Fingerprints include the new material so cached semantic reviews cannot outlive it.
Natural-language adoption, including whether L0 actually wins in prose, still needs semantic
review. The native frame now takes its injection timestamp from SQL with microseconds: a JS
millisecond clock could predate a row created earlier within that same millisecond.

`pnpm --silent eval:customer-memory` is the deterministic gate for memory-recall code changes
(including an RSI-proposed strategy change). It executes policy/coverage tests and real isolated
SQL lifecycle, consumption, candidate isolation, automation, privacy and metrics checks, writes
JSON reports and a summary under ignored `tmp/customer-memory-regression/`, and returns nonzero
for a failed, empty or missing measurement. It never calls a paid model or applies a proposal.
This repo has no general RSI execution module to rewrite; the command supplies a regression
contract for that allowed change surface without claiming an automatic RSI deployment chain.
The first actual command run passed 22 unit cases and 50 DB cases, exit 0, with a dirty-tree
marker recorded honestly (`AiNativeCrm-memory-28-policy-regression-gate.log`).

Candidate reads now scan beyond inaccessible source batches and return a continuation when
the bounded scan is incomplete. An empty partial page is not absence. Sort tuples include risk,
full SQL microseconds and UUID; private source IDs are removed, including outside the displayed
quote window. `source-access.ts` chunks RLS checks to avoid long URL or PostgREST response caps.
Confirmed-memory status and conflict queues each have their own continuation; usage cursors
are also bound to the actual artifact. Continuations use authenticated encryption with the
existing internal secret and org/actor/contact/list/filter binding. This strengthens the default
opaque authenticated cursor: skipped private positions are confidential as well as untamperable.
No new environment knob or optional service is required. UI paging preserves loaded records
and ignores older responses that would replace a newer page.

Measured so far: metrics component/route/panel suite 12 passed; evaluation/route regression
42 passed; pagination/cursor/source/component routes 28 passed; real SQL consumption + metrics
19 passed before the new queue stress case, then consumption suite 16 passed including 510
private candidates followed by 68 visible candidates at equal-microsecond positions. All these
are selected measurements, not the final whole-suite verdict. Typecheck and scoped ESLint
passed before the last UI fixture/race additions. Production rebuild and expanded browser
acceptance (manager metrics, agent source privacy with >100 records, >50 conflict pagination)
were pending at that measurement point. Full original-issue acceptance still must be audited.

## Metrics and pagination acceptance checkpoint — 2026-11-13

The final production rebuild passed (`AiNativeCrm-memory-28-metrics-pagination-final-build.log`).
Full ESLint completed with 0 errors and 477 existing warnings; typecheck exited 0. The expanded
candidate component suite passed 6 cases, including an empty partial page and a late first-page
response that must not replace loaded continuation rows.

The current three-case Playwright suite passed against the isolated fresh-baseline Supabase
stack (`AiNativeCrm-memory-28-metrics-pagination-final-e2e.log`):

- Manager report confirmation/rejection and used-memory correction feed real SQL metrics:
  confirmation 1/2, rejection 1/2 and report correction 1/1. The panel states denominators and
  leaves no-sample statistics empty. Manager metrics.
- A real authenticated agent skips 120 inaccessible automatic suggestions, sees only public
  candidates, and loads all 105 confirmed memories without losing equal-microsecond positions.
  The manager-only metrics endpoint returns 403; encrypted cursors reject tampering and reuse
  for another contact with 400. Agent pagination.
- A manager loads all 61 conflicts across two pages with identical timestamps and no duplicate
  or missing IDs. Conflict pagination.

These are real browser/auth/SQL paths with synthetic customer data. Native model consumption
remains independently covered by the SQL-backed deterministic Pi fixture; no external model or
real customer message was used. The original full-unit diagnostic remains live, and is not a
final frozen-tree acceptance result. A post-commit negative control and the full requirement
audit remain outstanding at this checkpoint.

The metrics polling race has a reproducing test: an earlier successful response arriving after
a newer 403 restored figures that should have stayed hidden (1 failed, 2 passed). The component
now accepts only the latest request within an effect; all 3 metric component cases pass. Logs:
`AiNativeCrm-memory-28-metrics-poll-negative.log` and
`AiNativeCrm-memory-28-metrics-poll-fixed.log`. The production build/browser results above
precede this final concurrency change and must not be presented as its frozen-tree verdict.

### Current Living System Checklist for metrics and evaluation

1. Input: `metrics.ts` consumes candidate decisions, conflict ages and SQL consumption/correction
   receipts; `evaluation.ts` joins receipts to the still-verifiable historical SQL policy.
2. Output: `CustomerMemoryMetrics` exposes review backlog/outcomes in the contact panel;
   `evaluate-run.ts` feeds policy findings to the existing workbench evaluation API and panel.
3. Record: metrics are read-only. Human decisions and corrections keep their existing audited
   mutation paths; the evaluation API persists its result with a material fingerprint.
4. Screen: explicit numerator/denominator and no-sample states in the manager metrics panel;
   deterministic policy findings in the existing run evaluation view.
5. Door: existing contact dossier and workbench report routes; no new navigation destination.
6. Anti-death: contact queues expose continuation, age and conflict waiting time; nightly jobs
   preserve recurring scheduling. Pure metrics reads need no additional action scheduler.
7. Configuration: no new environment variable or service. Metrics require current manager
   authority; unavailable readings remove old figures and show retry instead of invented zeros.
8. Continuity: model-created L2 goes to human confirmation; reviewed L1 returns to fresh task
   context. A correction flags only the exact still-current used revision for human review.
9. Return loop: decisions alter the queue and metrics; corrections alter review status; policy
   violations fail evaluation and `eval:customer-memory` guards recall-strategy changes.
10. Map: `chat-first-runtime-parity.architecture.json` connects real decision/receipt inputs to
    metrics and review, and receipt/policy inputs to evaluation and the existing workbench UI.

### Remaining capacity audit

The audit identified beyond-window task relevance and recurring conflict review coverage.
At `e0a14b36`, `readConfirmedCustomerMemory` ranked a recent 50-row SQL window plus independent
locks, so an older unlocked task-relevant preference could fall outside the window (addressed
by the later checkpoint below). Automatic conflict review currently declares partial coverage
beyond 100 confirmed rows but does not yet prove eventual review of every page. That maintenance
limit still requires resolution against the issue, not waived acceptance.

### Upstream comparison and selected-suite reconciliation

An independent detached worktree at unmodified `origin/main` (`0ff9f40c`) reproduced 13
failures among 96 selected upstream diagnostic cases (83 passed). Five assert automatic
workflow triggers that the upstream CI-pause commit deliberately removed; a sixth is the
release guard's unconsumed `exige_acao` fragment case. Other failures involve source-scan or
browser-environment checks, including timeouts under load. This is not proof that every
failure in the still-running whole-repository diagnostic has been reconciled. Raw receipts:
`AiNativeCrm-memory-28-upstream-baseline-failures.log` and ignored
`tmp/memory-28/upstream-baseline-failures.json`. No workflow was reactivated to satisfy them.

The 419-case feature/structural selection had 415 passes and 4 failures: two screenshot-index
checks before staging the new images, the new metrics-poll reproducer before its fix, and a
60-second Pi source-scan failure under load. After staging the images, both structural files
passed all 75 cases on a focused rerun; the metrics suite separately passed all 3. Logs and
JSON reports are retained rather than rewriting the first result as green. Final source checks
and the post-commit negative control still apply.

## Post-commit policy negative control — 2026-11-13

After commit `1e77e3d8`, a detached worktree deliberately disabled the required-lock finding in
`evaluateMemoryRecallPolicy`. The predicted policy regression failed: 1 failed, 7 passed,
exit 1. Restoring the committed file produced 8 passed, exit 0. The runner executed the same
eight production policy cases with the canonical test setup and a minimal Node-only config;
it did not edit the feature worktree or use an external model. Its first setup attempt omitted
the canonical environment placeholders and loaded zero cases; that result is retained and
does not count as a negative control. Receipt: ignored `tmp/memory-28/p3-negative-control.json`;
logs: `AiNativeCrm-memory-28-p3-policy-negative-with-setup.log` and
`AiNativeCrm-memory-28-p3-policy-restored.log`.

The original long full-unit diagnostic is now terminal, exit 1: 1,322 files passed, 19 failed;
13,110 cases passed, 23 failed, 1 expected failure and 1 skipped, with 2 worker-start errors.
Its 82-minute execution spans later repairs and is explicitly not a current frozen-tree gate.
The independent upstream comparison and selected-suite repair results above explain part,
not all, of that verdict. Remaining capacity fixes and final whole-suite reconciliation remain
required before completion.

Current committed-tree follow-up at `1e77e3d8`: typecheck and focused metrics ESLint exited 0;
production build exited 0; all three real-browser memory cases passed again in 28.1 seconds.
Logs: `AiNativeCrm-memory-28-p3-final-typecheck.log`, `AiNativeCrm-memory-28-p3-poll-lint.log`,
`AiNativeCrm-memory-28-p3-poll-build.log` and `AiNativeCrm-memory-28-p3-poll-e2e.log`.
This includes the final polling-race fix. The detached comparison/negative-control worktree
was restored and removed after its successful restore run.

## Task relevance before the SQL window — 2026-11-13

A new real-pg15 invariant placed an unlocked email preference behind 65 newer unrelated facts.
The original code omitted it from a Chinese email-drafting task: 1 failed, 9 passed. The bounded
SQL read now scores the full tenant/contact's valid L1 set by the same bounded task terms used
for final ranking, then selects its 50-row window. Review warnings retain their lower priority,
locks are still loaded independently, and freshness/ownership/hash fences still run after the
optional remote search. Shared terms include CJK bigrams; text remains a bound SQL parameter.
The database returns at most 51 rows for the ordinary window and does not copy an unbounded
profile into a model prompt. Partial coverage and non-absence semantics are retained.

Measured after the fix: the four selected lifecycle/consumption/integration/privacy DB suites
passed 34 cases; policy/recall/legacy coverage/native evaluation passed all 23 cases. Typecheck
and scoped ESLint exited 0. Logs: `AiNativeCrm-memory-28-older-relevance-before.log`,
`AiNativeCrm-memory-28-older-relevance-after-db.log`,
`AiNativeCrm-memory-28-older-relevance-unit.log`,
`AiNativeCrm-memory-28-older-relevance-typecheck.log` and
`AiNativeCrm-memory-28-older-relevance-lint.log`.

This is deterministic local relevance, not a semantic-model recall measurement. Eventual
conflict-review coverage, remote-only relevant hits outside the local candidate set and the
final whole-issue audit remain open.

The visibility audit also found that extraction writes `memory_result.status=unavailable`
and `reason=model_not_configured` to `job_queue`, but the contact/report memory UI does not
consume those records. Its operations disclosure currently shows only synchronization and
cleanup. User-visible extraction/maintenance status, an actionable configuration/retry path,
and source-aware authorization for that surface still need implementation and frontend proof.
Recording a failure in SQL alone does not satisfy the Living System visibility/anti-death gate.

At clean commit `cbff18fd`, the actual `pnpm --silent eval:customer-memory` entrypoint passed
23 policy/evaluation cases and 51 real-DB cases, with 0 failed/skipped and exit 0. The summary
records `working_tree_dirty=false` and the exact commit:
`tmp/customer-memory-regression/2026-11-12T17-30-52-269Z-6896ad1a/summary.json`;
log: `AiNativeCrm-memory-28-relevance-regression-gate.log`.

Post-commit negative control in an isolated worktree restored recent-only SQL ordering:
the older-preference case failed exactly (1 failed, 9 passed). Restoring the committed source
returned all 10 cases to green, exit 0. The first mutation accidentally omitted `ORDER BY`
and produced invalid SQL; its separate log is retained and is not counted as the targeted
negative control. Receipt: `tmp/memory-28/relevance-negative-control.json`; valid negative and
restored logs: `AiNativeCrm-memory-28-relevance-postcommit-negative-valid.log` and
`AiNativeCrm-memory-28-relevance-postcommit-restored.log`. The worktree was restored and removed.

## Owned SQL lookup for semantic hits — 2026-11-13

The semantic recall invariant first reproduced an old unlocked preference omitted despite a
valid remote hit (1 failed, 7 passed). Its first fixture attempt also tried to flip the contact
privacy flag directly, which SQL correctly refused; the valid privacy case now invokes the
actual LGPD cascade and is not counted as a product regression.

`mem0.ts` now resolves at most 100 returned identity/hash tuples to the current contact's SQL
rows, independently of the lexical top-50 window. `user_id`, the hashed CRM identity and
content hash must agree. Only SQL fields are retained. Before returning, it repeats the SQL
semantic lookup and checks current hashes, expiry, tombstones and contact privacy, then applies
the shared context budget/lock policy. Remote prose never enters the query or returned context.
Missing/invalid hits remain non-evidence of absence; provider failure retains local fallback.

The new real-pg15 suite covers valid remote-only hits, wrong user/identity/hash/contact/tenant,
changes during search, retirement/expiry/hash changes between SQL verifications, actual contact
anonymization and outage with a valid lock. Its 12 cases are included in
`eval:customer-memory`. The actual unified command passed 23 unit and 63 real-DB cases, with
0 failed/skipped (`AiNativeCrm-memory-28-semantic-regression-gate.log`; ignored summary under
`tmp/customer-memory-regression/2026-11-12T17-41-11-176Z-3ce96376/`). The integration unit suite
separately passed 17 cases. External search responses are controlled fixtures, not a live Mem0
service or a semantic-quality benchmark. Recurring conflict-page coverage, background-status
UI and final whole-issue acceptance remain open.

The semantic fix's typecheck and focused ESLint exited 0. After commit `d38529f8`, deliberately
omitting verified semantic rows from final selection caused exactly the outside-window case
to fail (1 failed, 11 passed). Restoring the committed source passed all 12. The detached
worktree was restored and removed. Receipt: `tmp/memory-28/semantic-negative-control.json`;
logs: `AiNativeCrm-memory-28-semantic-postcommit-negative.log` and
`AiNativeCrm-memory-28-semantic-postcommit-restored.log`.

## Durable conflict-review page implementation — 2026-11-13

Two real-DB regressions first reproduced the capacity gaps: a 113-memory review stopped after
one model call, and changing the last row did not create a new nightly review event (2 failed,
13 passed; `AiNativeCrm-memory-28-review-pages-before.log`).

`review-pages.ts` now traverses triangular pairs of 50-row UUID ranges, including each range
itself. Every pair can therefore be considered, while a model request contains at most 100
facts. The created-time horizon stays fixed for a chain; each page reloads current valid SQL
versions. A fixed left-range upper bound avoids shifting the range after a concurrent deletion.
This is bounded execution, not one unbounded profile prompt or a cap silently called complete.

`jobs.ts` commits the current page result and deterministic next event in the same contact-
and exact-lease-fenced transaction. The existing event dispatcher/queue claims the next page;
duplicate event delivery does not create another job. Missing model configuration stops the
chain as unavailable without creating a success or an automatic promotion. The existing
unavailable-status UI gap still needs closure. Old queued payloads without paging fields are
valid and start from the first range; no new environment setting or schema is introduced.

The nightly fingerprint now aggregates every currently valid confirmed ID/hash/policy revision
instead of reading only the first 101. Review marking and prior conflict keys retain existing
human-authority and body/lock preservation rules. The first revised automation run passed all
15 cases, including all 6,328 pairs among 113 facts across six calls, one cross-page conflict,
unchanged locked content and zero L1 promotions. Further horizon/retirement/lost-lease tests
and current-tree unified checks are pending at this checkpoint.

The expanded unified regression then passed 23 unit and 67 real-DB cases (0 failed/skipped,
exit 0), including the fixed horizon, retirement-without-range-shift and lost-lease cases.
Typecheck and focused ESLint exited 0. Logs: `AiNativeCrm-memory-28-review-pages-regression-gate.log`,
`AiNativeCrm-memory-28-review-pages-typecheck.log`, `AiNativeCrm-memory-28-review-pages-lint.log`;
summary: ignored `tmp/customer-memory-regression/2026-11-12T17-49-16-881Z-19f6d67c/summary.json`.
These prove deterministic traversal and controlled conflict output, not a live model's semantic
judgment quality. The background-status/retry UI and final requirement audit remain incomplete.

The updated architecture/source-boundary selection passed all 168 cases
(`AiNativeCrm-memory-28-review-pages-structure.log`). The map now includes the actual
automation → page coordinator → durable automation continuation loop, without an HTML re-render.

Post-commit negative control at `d2c22b0e` prevented continuation-event publication. The exact
113-memory traversal case failed (one model call instead of six): 1 failed, 16 passed, exit 1.
Restoring the committed coordinator returned all 17 automation cases to green, exit 0. The
isolated worktree was restored and removed. Receipt: `tmp/memory-28/review-pages-negative-control.json`;
logs: `AiNativeCrm-memory-28-review-pages-postcommit-negative.log` and
`AiNativeCrm-memory-28-review-pages-postcommit-restored.log`.

### Remaining background-status acceptance

The contact panel and report footer need an actual consumer for body-free extraction and
maintenance status, including missing model configuration and incomplete page chains. The
status surface must obey source conversation/run access, current membership and contact privacy;
an inaccessible first batch must not become a false empty state. Raw job payloads and errors
must not be exposed. Retry must be limited to these two memory job kinds, current owner/manager
authority and support-write policy, with a version check, idempotency and actor audit. It must
preserve the source boundary and never turn L2 into L1. A real-browser missing-configuration →
actionable explanation → authorized retry path, plus revoked/foreign/private-source negative
cases, is required before the visibility/anti-death checklist can be considered complete.

## Visible background work and safe retry — 2026-11-13

`activity.ts` and `/api/v1/ai/customer-memory/activity` expose body-free job state for only
extraction and consolidation. They lock the active contact, recheck accepted membership and
current ownership, and consult session RLS for source conversations and workbench runs while
holding source-row locks. Raw payloads, source IDs and error text are not projected. Confidential
microsecond cursors walk past private-heavy batches; empty partial pages explicitly remain
incomplete. Retry capabilities come from this fresh SQL authority check, rather than cached
parent UI permissions, so ownership changes update both the display and the write guard.

Retry preserves the original source/time boundary and same job ID. A current owner/manager
must present its revision and request key; running or successful completed work cannot be
requeued. An acknowledged key is idempotent, including after worker execution. Membership and
source access are checked even on replays. The API applies support-write policy and emits one
actor-bound `ai.customer_memory_job_retried` audit for a new retry. There is no new setting,
service, schema migration or promotion path.

`CustomerMemoryActivity` is reachable within the existing contact queue and report footer. It
distinguishes unavailable from an empty suggestion queue, links the existing model settings,
folds operational records, shows queued/failed/continuation states and supports authorized
retry. Unknown HTTP outcomes retain their request key; old poll responses cannot restore data
after a later denial. Client read-only support mode keeps mutations unavailable.

The final production build passed and all four real-browser scenarios passed (32.7 seconds),
including the new report → settings link → contact retry → pending SQL job and single actor
audit path. The ordinary agent scenario proves private job IDs/errors are absent, private-source
retry is denied, current ownership permits retry and soft-revoked membership rejects a replay.
Report explanation and
contact after retry contain synthetic data.
The browser's unavailable worker receipt is explicitly synthetic; it does not claim a live
provider was contacted. Actual queue claiming and canonical extraction are independently proven
by the DB case that requeues the job, calls `claimJobs`, generates an exact-evidence L2 candidate,
completes the lease and leaves L1 empty.

Current measurements: 29 selected route/component/source cases passed, followed by all 6
activity component cases including dynamic ownership changes. The unified memory regression
passed 23 unit and 76 DB cases before adding the queue-claim case; the complete activity DB
suite then passed all 10. Logs: `AiNativeCrm-memory-28-activity-final-unit.log`,
`AiNativeCrm-memory-28-activity-ownership-unit.log`,
`AiNativeCrm-memory-28-activity-regression-gate.log`, `AiNativeCrm-memory-28-activity-claim-db.log`,
`AiNativeCrm-memory-28-activity-final-build.log`, `AiNativeCrm-memory-28-activity-final-e2e.log`.
Initial DB fixture failures were UUID parameter casts; the first typecheck found an incorrectly
typed support-response stub. Both were repaired, not counted as product acceptance. The latest
source checks are scoped; the original full-unit diagnostic remains non-green and stale.

Living System closure for this surface: worker receipts feed visible status; an authorized
human retry feeds the real queue and L2 review cards; the actor audit records the action;
the existing model settings are the configuration door; failure stays visible with a next
action; current source/role guards fence the loop. The architecture connects actual automation
→ status → report/contact review and status → bounded automation retry. Full original-issue
acceptance and frozen-tree whole-repository checks still require the final audit.

## Authority retry negative control and L0 namespace audit — 2026-11-13

After commit `482a6649`, an isolated detached worktree changed only retry authority
from `confirm` to `propose`. The predicted current-owner case failed and the other nine
activity DB cases passed. Restoring the committed source returned all ten to green.
Logs: `AiNativeCrm-memory-28-activity-negative.log` and
`AiNativeCrm-memory-28-activity-restored.log`. The product branch was never sabotaged.

The final requirement audit found that singular reserved prefixes did not cover actual L0
namespaces such as `orders.total_cents` and `crm_leads.status`. The policy now reserves
business namespaces (including their plural forms) and bare projected business fields,
while allowing customer dimensions such as `payment.method` and
`commercial.price_sensitivity`. The extraction instruction uses the same distinction.
The new policy test first failed on `orders.total_cents` (one failed, eight passed),
then passed with the guard. A real SQL test exercises both the L1 and L2 writers and
checks that refused requests leave neither fact nor candidate rows. This validates
structured attributes; free-form human text remains quoted customer context, not an
automatically classified business or enterprise-policy authority.

The last structural batch passed 231 cases across evidence, architecture, decorative
controls and Pi boundaries. Final whole-tree unit/database/build checks remain pending;
none of these selected results is an all-suite completion claim.

## Requirement audit — current implementation

The scope is Issue #28 P0–P3, as re-read from GitHub including its architecture comment.
Account/deal subjects and private personal notes are explicit non-goals. No auto-promotion,
remote-prose authority or paid-provider requirement has been introduced.

| Requirement | Implementation and decisive verification |
| --- | --- |
| L0 / L1 / L2 / L3 / L4 separation | `business-facts.ts`, `policy.ts`, `context.ts`; actual native-request DB consumption tests exclude candidates/other contacts/expired facts and separate business/checkpoint blocks. L0 names refused by both writers; L4 remains the knowledge channel. |
| SQL truth and optional Mem0 | `integrations/mem0.ts`; lifecycle and semantic-recall DB tests check current org/contact/hash/TTL after search, SQL-only bodies, an old semantic hit outside the lexical window and provider failure retaining valid locks. Existing reconciliation/privacy suites remain part of the regression. |
| Lifecycle and replacement | Migrations 0409–0411, policy and lifecycle services; SQL constraint tests plus human-lifecycle tests cover ephemeral expiry, durable review, explicit unlock, manager conflict decisions, stale revisions, replacement lineage and transfer/revocation. |
| Source-backed automatic L2 | Migration 0410 producers + `jobs.ts` + `extraction.ts`; actual close/checkpoint/task/business events, real queue claim, exact inbound evidence, missing provider, stale source, lost lease and anonymization. No checkpoint-summary copy to L1. |
| Human review embedded in work | Report footer `CustomerMemoryCandidates`, contact `CustomerMemoryPanel`; real browser confirms/rewrite-confirms/rejects, locks/unlocks/retires and sees evidence and used-memory correction. Explicit remember, manual merge and reason/cooldown are covered through real SQL services and routes. |
| Fresh owner / manager authority | `authority.ts`; real SQL tests cover colleague-only proposals, current conversation/open-lead ownership, reassignment, revoked membership, manager-only arbitration and locked replacement requiring unlock. Retry authority negative control: one predicted failure of ten; restoration ten passed. |
| Nightly maintenance | `consolidation.ts`, `review-pages.ts`; >200 candidate exact-duplicate clustering, expiry preserving unknown-write cleanup, recurring scheduling, all 6,328 pairs across 113 confirmed facts in 6 bounded calls, no locked-body rewrite, fixed horizon and lease-fenced continuation. This is deterministic clustering plus model-assisted conflict review, not semantic candidate merging. |
| Per-request injection and visible usage | `consumption.ts` + native Pi seam, workbench start/resume/specialists, inbound and drafts; real native deterministic provider checks model-step acknowledgement and callback draining. Refresh removes stale L1/L3; receipts bind exact current run/service/draft generation. Report/draft usage links and correction mark exact revision without rewriting body/lock. |
| Metrics and eval / RSI regression | `metrics.ts`, `evaluation.ts`, `evals/memory-policy.ts`, `scripts/eval-customer-memory.ts`; independent SQL metrics validate rates/denominators, median latency, >7d backlog, conflict ages and unique corrected-document rates. Native receipt policy regressions check locks, TTL, scope, metadata and honest fallback. Semantic prose remains explicitly review-required. |
| Privacy and pagination | SQL tenant/contact FKs and service-only RLS; current session source RLS, anonymization/merge tombstones, preserved ambiguous-write reconciliation and organization cleanup fence. Private-heavy/equal-microsecond browser and DB checks cover candidates/status/conflicts/usage; encrypted cursor binding prevents private-ID disclosure and cross-actor/resource reuse. |
| Observable failure and recovery | Activity endpoint/UI distinguishes unavailable from empty, links model configuration and exposes body-free state. Authorized same-job retry preserves source/time boundaries and request-key idempotency; real queue/extraction test creates L2 only. |
| Self-host and engineering | Versioned migrations + idempotent baseline + MANIFEST + generated types, release fragment, architecture JSON with actual edges, user journey and synthetic screenshots. Full frozen-tree gates and their limits must be recorded below before completion. |

Frozen-tree memory regression at `4778d18f`: 24 unit + 78 database cases, zero failures/skips,
exit 0, clean-tree receipt `tmp/customer-memory-regression/2026-11-12T18-36-46-958Z-b6c0cda6/summary.json`.
Full lint: exit 0, 477 repository warnings. Typecheck: exit 0. Data-bearing self-host update:
exit 0, all 10 seeded rows retained and occupation-view identity preserved. Earlier memory-specific
baseline reapplication also preserved two new-kind jobs, one usage receipt and eight candidates.
Whole-unit/database results remain pending; the final production/browser receipt is recorded
below. Do not check the final worklist entry or close the issue before reconciliation.

## Final production/browser verification — 2026-11-13

The production build at source commit `4778d18f` exited 0, followed by all four
Chromium scenarios passing (1.4 minutes), against the dedicated fresh-baseline Supabase
stack with optional model/service credentials absent. Logs:
`AiNativeCrm-memory-28-final-frozen-build.log` and
`AiNativeCrm-memory-28-final-frozen-e2e.log`. The browser verifies the real report,
contact, settings-link, Auth, private-source, paging, retry and SQL/audit paths, with
explicitly synthetic customer/model prerequisites. It does not certify live LLM prose.

The post-commit namespace negative control at `4778d18f` reverted only plural L0
namespace protection. Exactly the new canonical-namespace test failed (one failed,
eight passed); restoring the source returned nine passed. Logs:
`AiNativeCrm-memory-28-business-namespace-negative.log` and
`AiNativeCrm-memory-28-business-namespace-restored.log`. Both disposable sabotage
worktrees have been removed after byte-for-byte restoration.

The optional-integration contract now describes current owner confirmation, L2 event
extraction, per-request native SQL refresh, expiry/locks and usage correction instead
of the earlier manager-only/manual-write description. The README links this contract.
The dated 2026-10-03 integration evidence remains a historical record.

Whole-repository unit and database runs are still live; no final all-suite verdict is
claimed. Observed unit failures include previously reproduced upstream failures and
additional unreconciled slow-scan/component failures. The whole DB scan failure also
requires terminal diagnostics. The full completion checkbox remains unchecked and
PR [#29](https://github.com/helsome/AiNativeCrm/pull/29) remains Draft until reconciliation.

## Whole-database terminal result and HTTP retry repair — 2026-11-13

The whole pg15 database run is terminal: 274 files, 2313 passed, one timeout failure,
one expected failure and one skip (1180.78 seconds). The sole failure was the generated-column
source scan exceeding its original 30-second deadline. Rerunning that unchanged scan and
the file with a worker-termination warning, with a 120-second deadline, passed both files
and all nine assertions (52.51 seconds). No memory DB assertion failed. Logs:
`AiNativeCrm-memory-28-final-full-db.log` and `AiNativeCrm-memory-28-final-db-scan-recheck.log`.
The original nonzero verdict is retained, not relabeled as an all-green whole run.

The whole-unit diagnostic detected an actual new HTTP self-host regression in
`CustomerMemoryActivity`: direct `crypto.randomUUID()` requires a secure context.
The component now uses the existing CRM `randomId()` helper. Its uncertain-outcome
retry test removes `randomUUID` while retaining `getRandomValues` and verifies a valid
v4 UUID plus same-key replay. The reproduction failed exactly that component case
(one failed, five passed, one unhandled rejection); the repair passed all six component
cases plus all three shared UUID tests. Logs: `AiNativeCrm-memory-28-insecure-retry-red.log`
and `AiNativeCrm-memory-28-insecure-retry-green.log`.

The real-browser retry scenario now removes the secure-context API before navigation,
so the next build/browser verification must prove the same fallback through the actual
POST and SQL/audit path. The old four-case build/browser proof remains valid for its
previous source snapshot, not this repair. The initial whole-unit run is still live;
it began before this repair and must be interpreted with the exact changed-file tests,
not advertised as an untouched final-tree all-green result. Full-unit failure
reconciliation and this repaired production/browser run remain required.

## Implemented-scope worklist reconciliation — 2026-11-13

The first ten acceptance items are checked against the requirement table, the 24+78
regression receipt, all memory/security/human-review files in the now-terminal whole
DB run, data-bearing update verification, and the four real-browser business flows.
This records completed feature contracts, not an all-suite green claim. The final
cross-repository verification item stays unchecked pending the whole-unit terminal
analysis and the repaired HTTP browser scenario.

The HTTP fix is committed at `fd0d37cb`. In an isolated post-commit worktree, restoring
only the unsafe call caused exactly the predicted two failures of nine: the new
non-secure-context retry case and the existing whole-client UUID guard. Restoring the
committed source returned all nine to green with zero errors. Logs:
`AiNativeCrm-memory-28-http-retry-negative.log` and
`AiNativeCrm-memory-28-http-retry-restored.log`. The primary product tree was not sabotaged.

## Repaired production/browser receipt — 2026-11-13

The production rebuild for source commit `fd0d37cb` exited 0, followed by all four
real Chromium scenarios passing (1.1 minutes). The background-retry scenario removes
`crypto.randomUUID` before navigation, asserts that it is absent, and still verifies
actual same-job POST, SQL source preservation and one actor audit. The unit case also
proves a valid v4 request key and uncertain-outcome key reuse. This tests the missing-API
capability rather than claiming every difference of an arbitrary insecure origin.
Logs: `AiNativeCrm-memory-28-http-retry-build.log` and
`AiNativeCrm-memory-28-http-retry-e2e.log`. The isolated negative-control worktree was
restored byte-for-byte and removed. Typecheck and scoped ESLint exited 0.

Only the long whole-unit diagnostic remains live (tool session 53820). Its original
UUID-guard failure is a repaired regression with current unit and browser evidence;
all other failures still require the terminal report and reconciliation. The final
verification checkbox and PR Draft status remain pending that work.

## Final acceptance and whole-run reconciliation — 2026-11-13

Issue #28 and its architecture comment were re-read from GitHub; the issue is unchanged
(updated 2026-11-12 12:10:36 UTC). All P0–P3 feature requirements map to the implementation
and decisive evidence table above. Account/deal inheritance and private personal notes
remain the issue's explicit non-goals. No feature work is left pending.

The long whole-unit run is terminal, exit 1 after 4840.35 seconds: 1348 executed files,
13150 normal passes, 21 failures, one expected failure and one skip. The JSON reporter
counts the expected failure among its 13151 passed cases; the console separates it.
All 20 unit-test files changed by this branch appear in the full report. Nineteen had
no failed cases; the HTTP retry component's old-call failure has independent current
six-case component, three-case shared UUID and four-case real-browser proof.

Each of the 21 failed assertions has an explicit disposition in
validation-summary.json:

- 2 detect the HTTP UUID regression repaired in `fd0d37cb`; new current tests and browser
  scenarios pass, and the post-commit negative control fails on precisely that defect.
- 11 pass with unchanged assertions in the single-worker rechecks. The six-file batch
  passed 55/55; the current four-file baseline batch passed 13 and retained three failures.
- 8 independently failed on pure `origin/main` as well: five stale automatic-workflow
  assertions contradict upstream's intentional Actions pause; the other three are the
  release-guard, theme and upload-fixture cases. Their original/current nonzero reports
  remain retained. Extra theme-hook and Node-upload diagnostics did not remove those
  failures; no unsupported root-cause claim or unrelated product fix is made here.

The original three unhandled errors are also accounted for: one is the repaired raw
`crypto.randomUUID` call. The other two are worker-startup timeouts, not completed tests.
Both omitted files were explicitly rerun: `motion-disclosure.test.tsx` (5 cases) and
`conexao-caida-banner-papel.test.tsx` (16 cases), all 21 passed, exit 0, zero skips/errors.
Receipt: `tmp/memory-28/worker-startup-recheck.json`. Neither omitted file is treated as
covered merely because other files passed.

The full pg15 run covers all 274 invariant files, with only the unchanged generated-column
scan timing out; its scan/worker recheck passes all nine cases. Every changed memory DB
file ran. At that historical checkpoint the SQL/worker/model backend was byte-identical to the
24-unit + 78-DB regression snapshot; the subsequent follow-up timing delta requires a new gate. Production build,
typecheck, scoped ESLint and all four actual-browser paths verify that repaired product.
Latest release-fragment and migration-collision checks exit 0. The current main remains
`0ff9f40c`, with no conflicting main migration; Draft PR #25's shared numbers remain a
merge-order warning requiring a fresh collision check when either branch merges.

The final verification item records relevant passing checks and the explicit reconciliation of
whole-repository exceptions; the later timing repair is verified in the current summary above.
It is **not** a claim that `pnpm test:unit` or the original `pnpm test:db` was all green.
No workflow was reactivated, no assertion was weakened, and no live paid-model/provider
behavior is claimed. The final timing evidence is recorded below.

Living System Checklist (before the follow-up timing audit):

1. Input: migration 0410 close/checkpoint/task/business events, explicit proposals and human corrections.
2. Output: L2 report/contact review, L1 SQL recall before native requests, usage/correction and manager metrics.
3. Record: source evidence, event_log/job receipts, api_audit_log and per-model-step consumption receipts.
4. Screen: CustomerMemoryCandidates/Panel/Usage/Activity/Metrics on actual report/contact/draft surfaces.
5. Door: existing workbench report and contact dossier navigation; no unreachable standalone page.
6. Anti-death: recurring nightly scheduling, visible failures, confidential continuation and authorized same-job retry.
7. Configuration: existing model/integration settings, explicit TTL/review/lock/cooldown controls and missing-model explanation.
8. Continuity: automatic L2 → authorized human L1 → next native model request; no automatic promotion.
9. Return loop: rejection cooldown and usage correction change future candidate/review behavior and recall metadata.
10. Map: chat-first-runtime-parity.architecture.json contains the real producers, human decisions, request injection, receipts, evaluation and retry edges.

### Follow-up timing audit and repair

Final caller audit found that `planFollowupTiming` had called the gateway without the customer-memory request wrapper. Timing recommendations now receive valid locked communication constraints with the originating conversation/service boundary. The new delta is verified separately from the historical full-suite results.

The repair routes `planFollowupTiming` through `executePiTurnModelCall`, preserves its existing
`followup_decide_timing` provider binding, rejects mismatched contact identities, and pins
`getLeadContext` to the queued origin conversation. `beforeRead` rechecks the captured service
boundary on each refresh. The shared consumption wrapper preserves refresh exceptions that
Pi otherwise converts to empty output; successful consumption receipts cannot hide that failure.

TDD: the new timing wiring unit file failed all three cases before the fix, then passed with
all 13 existing parser cases. Initial native integration exposed two swallowed refresh errors;
after preserving the original exceptions all three SQL/native-provider cases passed. A fourth
case exercises the actual queued-turn handler with a second newer conversation; all 35 cases in
the follow-up engine/bridge/service-boundary regression passed. The deterministic memory
regression command now includes both new files. No new environment variable or migration is needed.

Final closure: the committed repair passed the 109-case memory gate. The new typed fixture then
passed the same frozen clean-tree gate at `988493a5`; it changes only test dependencies, not
production behavior. Production build at `1548b3d6` and four current browser paths pass, final
typecheck/scoped lint pass. Post-commit native DB negative controls independently measure memory
injection (4 predicted failures), origin-conversation binding (1), and refresh-error propagation
(2); restored code passes all four timing cases. Receipts and log hashes are in the public JSON.

The final Living System Checklist additionally binds the existing queued follow-up input to the
request-time SQL context, emits `followup_decide_timing` job/conversation consumption receipts,
and preserves current-service errors so the queue's existing failure/termination handling acts
on the original cause. The architecture map connects this consumer to context and receipts.
No new settings, schema or navigation page were needed for this repair. The earlier report,
contact and draft review/correction UI remains the visible human feedback loop.
