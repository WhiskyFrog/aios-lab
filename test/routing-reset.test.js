import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { historyProjection } from "../src/routing-dispatch.js";
import { selectCandidate } from "../src/routing-policy.js";
import {
  decisionRecordFromSelection,
  RoutingDecisionLedger,
  RoutingLedgerConflictError,
  RoutingLedgerError,
  routingDecisionsPath,
} from "../src/routing-ledger.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");

const NOW = "2026-07-16T00:00:00.000Z";
const DISPATCHED_AT = "2026-07-16T00:01:00.000Z";
const FAILED_AT = "2026-07-16T00:02:00.000Z";
const RESET_AT = "2026-07-16T00:03:00.000Z";
const LATER_RESET_AT = "2026-07-16T00:04:00.000Z";

function config() {
  return {
    schema: "aios.routing/v1",
    tiers: [
      { id: "lower", rank: 1 },
      { id: "high", rank: 2 },
    ],
    capabilities: ["filesystem", "shell"],
    cost_classes: ["low", "high"],
    latency_classes: ["fast", "slow"],
    candidates: [
      {
        id: "claude-lower",
        provider: "claude",
        model: "claude-configured-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "claude-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "codex-lower",
        provider: "codex",
        model: "codex-configured-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "codex-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "claude-high",
        provider: "claude",
        model: "claude-configured-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "claude-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "slow",
      },
      {
        id: "codex-high",
        provider: "codex",
        model: "codex-configured-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "codex-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "slow",
      },
    ],
    policy: {
      high_tier: "high",
      distribution_window: 20,
      provider_targets: [
        { provider: "claude", weight: 1 },
        { provider: "codex", weight: 1 },
      ],
      limits: { fallbacks_per_action: 2, escalations_per_task: 2 },
      default_budgets: { cost: "high", latency: "slow" },
    },
    hints: [
      {
        selector: { task: "task-0099", plan: null },
        work_kind: "implementation",
        complexity: "low",
        risk: "low",
        required_capabilities: ["filesystem"],
        verification: "objective",
        cost_budget: "high",
        latency_budget: "slow",
      },
    ],
    overrides: [],
  };
}

function workload() {
  const hintSource = "routing.hints.task:task-0099";
  return {
    task_id: "task-0099",
    role: "implementer",
    work_kind: "implementation",
    parent_plan: null,
    complexity: "low",
    risk: "low",
    context_size: { bytes: 4_000, estimated_tokens: 1_000, band: "small" },
    required_capabilities: ["filesystem"],
    verification_burden: "objective",
    budgets: { cost: "high", latency: "slow" },
    approval: "not_required",
    retry: { count: 0, limit: 2 },
    history: { reviews_total: 0, changes_requested: 0, sessions_failed: 0, capacity_deferred: 0 },
    uncertainty_flags: [],
    minimum_tier: "lower",
    lower_tier: { eligible: true, rejection_reasons: [] },
    sources: {
      task_id: "task.metadata.id",
      role: "engine.active_role",
      work_kind: hintSource,
      parent_plan: "plan_scan",
      complexity: hintSource,
      risk: hintSource,
      context_size: "task.raw_utf8",
      required_capabilities: hintSource,
      verification_burden: hintSource,
      budgets: hintSource,
      approval: "task.metadata.approval",
      retry: "task.metadata.retry",
      history: "provided_review_session_history",
      minimum_tier: "lower_tier_gate",
      uncertainty_flags: "workload_evidence_validation",
      lower_tier: "documented_lower_tier_gate",
      diagnostics: "plan_and_history_validation",
    },
    diagnostics: { strict_planning_contract: false, plan_errors: [], history_errors: [] },
  };
}

function key(revision = "policy-v1", attempt = 1) {
  return { task: "task-0099", role: "implementer", attempt, policy_revision: revision };
}

// A choose() history entry attributed to an unrelated attempt of the same
// action: it is not part of the partial key under test, so it never
// collides with that key's own recorded generations, but it still lets the
// fixture's window/distribution arithmetic honestly reflect a real
// preceding ledger row when a test needs one to already exist on disk.
function decoyHistoryRow(selection, attempt = 97) {
  return {
    key: key(selection.key.policy_revision, attempt),
    step: 0,
    chosen: { candidate: selection.chosen.candidate, provider: selection.chosen.provider },
    reason: null,
  };
}

function choose({ revision = "policy-v1", attempt = 1, history = [] } = {}) {
  return selectCandidate({
    config: config(),
    workload: workload(),
    key: key(revision, attempt),
    history,
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
}

async function temporaryLedger(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = routingDecisionsPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  return { root, file, ledger: new RoutingDecisionLedger(file) };
}

// Builds a selected/dispatched/failed action at the given key, ready for a
// reset test, and returns the ledger snapshot right after.
async function seedFailedAction(ledger, { revision = "policy-v1", attempt = 1 } = {}) {
  const sel = choose({ revision, attempt });
  let snapshot = await ledger.load();
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(sel, { recorded_at: NOW }),
  );
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "failed",
    observed_at: FAILED_AT,
  });
  return { snapshot, selection: sel };
}

test("resetAction supersedes every row and unblocks a fresh same-key selection under a new revision", async (t) => {
  const { ledger, file } = await temporaryLedger(t);
  const { snapshot, selection } = await seedFailedAction(ledger);

  await assert.rejects(
    ledger.resolveKey(key("policy-v2")),
    /another policy revision/,
  );

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    reason: "routing config edited between runs",
    observed_at: RESET_AT,
  });

  const supersededRow = afterReset.decisions[0];
  assert.equal(supersededRow.status, "superseded");
  assert.equal(supersededRow.step, 0);
  assert.equal(supersededRow.observed_at, RESET_AT);
  assert.equal(supersededRow.events.length, 1);
  assert.equal(supersededRow.events[0].kind, "reset");
  assert.equal(supersededRow.events[0].reason.code, "policy_changed");
  assert.equal(supersededRow.events[0].reason.diagnostic, "routing config edited between runs");
  // No existing field besides status/events/observed_at changed in place.
  assert.deepEqual(supersededRow.chosen, selection.chosen);
  assert.deepEqual(supersededRow.workload, snapshot.decisions[0].workload);
  assert.equal(supersededRow.recorded_at, snapshot.decisions[0].recorded_at);
  assert.equal(afterReset.updated_at, RESET_AT);

  // Resolving under the new revision no longer raises finding 4's conflict.
  const resolved = await ledger.resolveKey(key("policy-v2"));
  assert.equal(resolved, null);

  // A fresh selection for the exact same partial key can now be recorded as
  // step 0 of a new, unrelated sequence, without deleting the superseded row.
  const fresh = choose({
    revision: "policy-v2",
    history: [decoyHistoryRow(selection)],
  });
  assert.equal(fresh.step, 0);
  assert.equal(fresh.parent_step, null);
  const afterFresh = await ledger.record(
    afterReset,
    decisionRecordFromSelection(fresh, { recorded_at: LATER_RESET_AT }),
  );
  assert.equal(afterFresh.decisions.length, 2);
  assert.equal(afterFresh.decisions[0].status, "superseded");
  assert.equal(afterFresh.decisions[1].status, "selected");
  assert.equal(afterFresh.decisions[1].key.policy_revision, "policy-v2");
  assert.equal(afterFresh.decisions[1].step, 0);

  // The post-reset, post-reselection ledger still passes every existing
  // load-time validation, including the updated_at invariant, with no
  // schema relaxation: reload it fresh from disk end to end.
  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(reloaded.decisions.length, 2);
  assert.equal(reloaded.updated_at, LATER_RESET_AT);
  assert.equal(reloaded.decisions[0].status, "superseded");
  assert.equal(reloaded.decisions[1].status, "selected");
});

// Reproduces dogfooding finding 4's real trigger via the exact projection
// routing-dispatch.js feeds into selectCandidate (both when resolving a fresh
// key and when recovering after a failure): history built from a ledger
// snapshot that still contains the actual superseded row a reset produced —
// not a decoy row for an unrelated attempt — must not make a fresh selection
// for that same partial key under the current policy revision raise the
// policy-revision conflict the reset exists to clear.
test("historyProjection excludes a reset key's real superseded generation so a fresh same-key selection under the new policy revision does not raise the policy-revision conflict", async (t) => {
  const { ledger } = await temporaryLedger(t);
  const { snapshot } = await seedFailedAction(ledger);

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });
  // The real superseded row from the reset above is present in the ledger
  // snapshot that routing-dispatch.js would load and project next.
  assert.equal(afterReset.decisions.length, 1);
  assert.equal(afterReset.decisions[0].status, "superseded");

  const fresh = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v2"),
    history: historyProjection(afterReset.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  assert.equal(fresh.step, 0);
  assert.equal(fresh.parent_step, null);
  assert.equal(fresh.key.policy_revision, "policy-v2");
});

test("resetAction refuses when any row for the key is already completed, with no write", async (t) => {
  const { ledger, file } = await temporaryLedger(t);
  const sel = choose();
  let snapshot = await ledger.load();
  snapshot = await ledger.record(snapshot, decisionRecordFromSelection(sel, { recorded_at: NOW }));
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "completed",
    observed_at: FAILED_AT,
  });
  const rawBefore = await readFile(file, "utf8");

  await assert.rejects(
    ledger.resetAction(snapshot, {
      task: "task-0099",
      role: "implementer",
      attempt: 1,
      observed_at: RESET_AT,
    }),
    (error) => error instanceof RoutingLedgerError && /already completed and cannot be reset/.test(error.message),
  );
  assert.equal(await readFile(file, "utf8"), rawBefore);
});

test("resetAction refuses for an unknown key, with no write", async (t) => {
  const { ledger, file } = await temporaryLedger(t);
  await seedFailedAction(ledger);
  const rawBefore = await readFile(file, "utf8");
  const snapshot = await ledger.load();

  await assert.rejects(
    ledger.resetAction(snapshot, {
      task: "task-0099",
      role: "implementer",
      attempt: 9,
      observed_at: RESET_AT,
    }),
    (error) => error instanceof RoutingLedgerError && /no recorded routing decision exists/.test(error.message),
  );
  assert.equal(await readFile(file, "utf8"), rawBefore);
});

test("resetAction fails closed on a concurrent conflicting write, with no write", async (t) => {
  const { ledger, file } = await temporaryLedger(t);
  const { snapshot } = await seedFailedAction(ledger);
  const left = snapshot;
  const right = await ledger.load();

  await ledger.resetAction(left, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });
  const rawAfterFirst = await readFile(file, "utf8");

  await assert.rejects(
    ledger.resetAction(right, {
      task: "task-0099",
      role: "implementer",
      attempt: 1,
      observed_at: LATER_RESET_AT,
    }),
    RoutingLedgerConflictError,
  );
  assert.equal(await readFile(file, "utf8"), rawAfterFirst);
});

test("resetAction never touches or reattaches an override on the existing row", async (t) => {
  const { ledger } = await temporaryLedger(t);
  const overridden = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1"),
    history: [],
    implementerDecision: null,
    override: {
      candidate: "codex-lower",
      source: "cli",
      selector: { task: "*", role: "implementer" },
      allow_fallback: false,
      displaced_config_candidate: null,
    },
    cooldowns: [],
    asOf: null,
  });
  let snapshot = await ledger.load();
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(overridden, { recorded_at: NOW }),
  );
  snapshot = await ledger.updateOutcome(snapshot, {
    key: overridden.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: overridden.key,
    step: 0,
    status: "failed",
    observed_at: FAILED_AT,
  });
  const overrideBefore = snapshot.decisions[0].override;
  assert.notEqual(overrideBefore, null);

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });
  assert.deepEqual(afterReset.decisions[0].override, overrideBefore);
  assert.equal(afterReset.decisions[0].status, "superseded");
});

async function seedResettableLedgerViaCli(root) {
  const ledger = new RoutingDecisionLedger(routingDecisionsPath(root));
  const sel = choose();
  let snapshot = await ledger.load();
  snapshot = await ledger.record(snapshot, decisionRecordFromSelection(sel, { recorded_at: NOW }));
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: sel.key,
    step: 0,
    status: "failed",
    observed_at: FAILED_AT,
  });
  return snapshot;
}

test("--help documents the route reset command", async () => {
  const { stdout } = await executeFile(process.execPath, [cli, "--help"], { windowsHide: true });
  assert.match(
    stdout,
    /aios route reset <task-id>:<role>:<attempt> \[--root <path>\] \[--reason <text>\]/,
  );
  assert.match(stdout, /route: 0 success, 64 usage error\./);
});

test("aios route reset resets a stranded action and exits 0", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-route-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedResettableLedgerViaCli(root);

  const result = await executeFile(
    process.execPath,
    [cli, "route", "reset", "task-0099:implementer:1", "--root", root, "--reason", "policy revision changed"],
    { cwd: root, windowsHide: true },
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    reset: true,
  });

  const ledger = new RoutingDecisionLedger(routingDecisionsPath(root));
  const state = await ledger.load();
  assert.equal(state.decisions[0].status, "superseded");
  assert.equal(state.decisions[0].events.at(-1).reason.diagnostic, "policy revision changed");
});

test("aios route reset exits 64 for a malformed selector, unknown key, and non-resettable rows, writing nothing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-route-reset-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedResettableLedgerViaCli(root);
  const filePath = routingDecisionsPath(root);
  const rawBefore = await readFile(filePath, "utf8");

  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "route", "reset", "not-a-selector", "--root", root],
      { cwd: root, windowsHide: true },
    ),
    (error) => error.code === 64 && /Invalid route reset selector/.test(error.stderr),
  );
  assert.equal(await readFile(filePath, "utf8"), rawBefore);

  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "route", "reset", "task-0099:implementer:9", "--root", root],
      { cwd: root, windowsHide: true },
    ),
    (error) => error.code === 64 && /no recorded routing decision exists/.test(error.stderr),
  );
  assert.equal(await readFile(filePath, "utf8"), rawBefore);

  // seedResettableLedgerViaCli left the row "failed"; only a "dispatched"
  // row can move to "completed", so build a second, independent completed
  // action (attempt 2) rather than mutating the first row's own history.
  const ledger = new RoutingDecisionLedger(filePath);
  let snapshot = await ledger.load();
  const priorSelection = choose();
  const completedSelection = choose({
    attempt: 2,
    history: [decoyHistoryRow(priorSelection, 96)],
  });
  const recordedAt = new Date().toISOString();
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(completedSelection, { recorded_at: recordedAt }),
  );
  snapshot = await ledger.updateOutcome(snapshot, {
    key: completedSelection.key,
    step: 0,
    status: "dispatched",
    observed_at: new Date().toISOString(),
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: completedSelection.key,
    step: 0,
    status: "completed",
    observed_at: new Date().toISOString(),
  });
  const rawWithCompleted = await readFile(filePath, "utf8");

  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "route", "reset", "task-0099:implementer:2", "--root", root],
      { cwd: root, windowsHide: true },
    ),
    (error) => error.code === 64 && /already completed and cannot be reset/.test(error.stderr),
  );
  assert.equal(await readFile(filePath, "utf8"), rawWithCompleted);
});

test("aios route reset usage errors exit 64", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-route-reset-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    [["route", "reset"], /Usage:/],
    [["route", "reset", "--root", root], /Usage:/],
    [["route", "reset", "task-0099:implementer:1", "--bogus", "x"], /Unknown option --bogus/],
    [["route", "reset", "task-0099:implementer:1", "--root"], /Missing value for --root/],
    [["route", "reset", "task-0099:reviewer:0"], /Invalid route reset selector/],
    [["route", "reset", "task-99:implementer:1"], /Invalid route reset selector/],
  ];
  for (const [argv, pattern] of cases) {
    await assert.rejects(
      executeFile(process.execPath, [cli, ...argv], { cwd: root, windowsHide: true }),
      (error) => error.code === 64 && pattern.test(error.stderr),
      `expected ${JSON.stringify(argv)} to exit 64 matching ${pattern}`,
    );
  }
});
