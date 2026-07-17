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
const LATER_RESET_AT2 = "2026-07-16T00:05:00.000Z";
const BEFORE_RESET_AT = "2026-07-16T00:02:30.000Z";

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
    history: historyProjection(afterReset.decisions),
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

// resetAction never requires or forces a policy-revision change: an operator
// resetting a stuck action without a routing-policy edit produces a fresh
// step-0 record whose key is identical in every field, including
// policy_revision, to the superseded generation's own step-0 row.
// findRecordIndex must not mistake that superseded row for the fresh
// generation's "existing" row -- through record() and through the same
// updateOutcome calls a real dispatch/outcome flow issues next.
test("resetAction supersedes every row and unblocks a fresh same-key selection under the same revision", async (t) => {
  const { ledger, file } = await temporaryLedger(t);
  const { snapshot, selection } = await seedFailedAction(ledger);

  // Same-policy reset: resolving under the unchanged revision must not raise
  // finding 4's conflict either, exactly like the changed-revision case.
  const resolvedBeforeReset = await ledger.resolveKey(key("policy-v1"));
  assert.equal(resolvedBeforeReset.active.status, "failed");

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    reason: "operator retry, no policy change",
    observed_at: RESET_AT,
  });

  const supersededRow = afterReset.decisions[0];
  assert.equal(supersededRow.status, "superseded");
  assert.equal(supersededRow.key.policy_revision, "policy-v1");
  assert.deepEqual(supersededRow.chosen, selection.chosen);

  // Resolving the still-unchanged revision now resolves as if the action had
  // never run, exactly like resolveKey does after a changed-revision reset.
  const resolvedAfterReset = await ledger.resolveKey(key("policy-v1"));
  assert.equal(resolvedAfterReset, null);

  // A fresh selection under the *same* policy revision, made through the
  // real historyProjection + selectCandidate path, has a key identical in
  // every field -- task, role, attempt, and policy_revision -- to the
  // superseded generation's own step-0 row.
  const fresh = choose({
    revision: "policy-v1",
    history: historyProjection(afterReset.decisions),
  });
  assert.equal(fresh.step, 0);
  assert.equal(fresh.parent_step, null);
  assert.deepEqual(fresh.key, selection.key);

  // Before the fix, this raised "Refusing to rewrite recorded decision
  // task-0099:implementer:1:policy-v1 step 0": findRecordIndex's unscoped
  // exact-key scan resolved to the superseded row above, whose recorded
  // content differs from the fresh selection.
  const afterFresh = await ledger.record(
    afterReset,
    decisionRecordFromSelection(fresh, { recorded_at: LATER_RESET_AT }),
  );
  assert.equal(afterFresh.decisions.length, 2);
  assert.equal(afterFresh.decisions[0].status, "superseded");
  assert.equal(afterFresh.decisions[1].status, "selected");
  assert.equal(afterFresh.decisions[1].key.policy_revision, "policy-v1");
  assert.equal(afterFresh.decisions[1].step, 0);

  // A real dispatch/outcome flow issues updateOutcome next, addressed by the
  // exact same (task, role, attempt, policy_revision, step) key. Without
  // scoping findRecordIndex to the fresh, still-open generation, this would
  // silently resolve to the closed, superseded row instead (index 0, the
  // first array match) and fail with "cannot move from superseded".
  const afterDispatch = await ledger.updateOutcome(afterFresh, {
    key: fresh.key,
    step: 0,
    status: "dispatched",
    observed_at: LATER_RESET_AT,
  });
  assert.equal(afterDispatch.decisions[0].status, "superseded");
  assert.equal(afterDispatch.decisions[1].status, "dispatched");

  const afterCompletion = await ledger.updateOutcome(afterDispatch, {
    key: fresh.key,
    step: 0,
    status: "completed",
    observed_at: LATER_RESET_AT,
  });
  assert.equal(afterCompletion.decisions[0].status, "superseded");
  assert.equal(afterCompletion.decisions[1].status, "completed");

  // Recording the identical fresh row again, before any outcome update,
  // remains an idempotent no-op within the still-open generation -- the
  // correction narrows what counts as "existing" for a closed generation,
  // it does not weaken protection within a still-open one.
  const idempotentSnapshot = await ledger.record(
    afterFresh,
    decisionRecordFromSelection(fresh, { recorded_at: LATER_RESET_AT }),
  );
  assert.equal(idempotentSnapshot.decisions.length, 2);

  // An actual attempt to rewrite the still-open fresh row with different
  // content is still rejected with a clear error.
  const mismatched = decisionRecordFromSelection(fresh, { recorded_at: LATER_RESET_AT });
  await assert.rejects(
    ledger.record(afterFresh, { ...mismatched, observed_at: LATER_RESET_AT2 }),
    /Refusing to rewrite recorded decision/,
  );

  // The ledger on disk reflects the real dispatch/outcome flow's last actual
  // write (afterCompletion), reloaded fresh end to end with no schema
  // relaxation, exactly like the changed-revision test above.
  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(reloaded.decisions.length, 2);
  assert.equal(reloaded.updated_at, LATER_RESET_AT);
  assert.equal(reloaded.decisions[0].status, "superseded");
  assert.equal(reloaded.decisions[0].key.policy_revision, "policy-v1");
  assert.equal(reloaded.decisions[1].status, "completed");
  assert.equal(reloaded.decisions[1].key.policy_revision, "policy-v1");
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

test("post-reset selection and ledger replay count the same generation-aware distribution window", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  let snapshot = await ledger.load();
  const ordinaryRecordedAt = [
    "2026-07-15T23:57:00.000Z",
    "2026-07-15T23:58:00.000Z",
    "2026-07-15T23:59:00.000Z",
  ];

  // Seed ordinary global distribution history through the same projection,
  // selection, and record path routing-dispatch.js uses.
  for (let index = 0; index < ordinaryRecordedAt.length; index += 1) {
    const ordinary = selectCandidate({
      config: config(),
      workload: workload(),
      key: key("policy-v1", 90 + index),
      history: historyProjection(snapshot.decisions),
      implementerDecision: null,
      override: null,
      cooldowns: [],
      asOf: null,
    });
    snapshot = await ledger.record(
      snapshot,
      decisionRecordFromSelection(ordinary, { recorded_at: ordinaryRecordedAt[index] }),
    );
  }

  const priorGeneration = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1"),
    history: historyProjection(snapshot.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(priorGeneration, { recorded_at: NOW }),
  );
  snapshot = await ledger.updateOutcome(snapshot, {
    key: priorGeneration.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });
  snapshot = await ledger.updateOutcome(snapshot, {
    key: priorGeneration.key,
    step: 0,
    status: "failed",
    observed_at: FAILED_AT,
  });
  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });

  assert.equal(afterReset.decisions.length, 4);
  assert.equal(afterReset.decisions[3].status, "superseded");
  const projectedHistory = historyProjection(afterReset.decisions);
  assert.equal(projectedHistory.length, 3);

  const fresh = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v2"),
    history: projectedHistory,
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  assert.equal(fresh.step, 0);
  assert.equal(fresh.distribution.observed, 3);
  // Before the correction, validateLedger replayed all four raw rows here,
  // so record() failed with "distribution.observed: must equal the actual
  // preceding ledger window" even though selection correctly observed three.
  assert.equal(afterReset.decisions.slice(-fresh.distribution.window).length, 4);

  const afterFresh = await ledger.record(
    afterReset,
    decisionRecordFromSelection(fresh, { recorded_at: LATER_RESET_AT }),
  );
  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(afterFresh.decisions.length, 5);
  assert.equal(reloaded.decisions.length, 5);
  assert.equal(reloaded.decisions[3].status, "superseded");
  assert.equal(reloaded.decisions[4].distribution.observed, 3);
  assert.equal(
    reloaded.decisions[4].distribution.counts.reduce((total, entry) => total + entry.count, 0),
    3,
  );
});

test("distribution replay keeps a generation that was still open at an earlier append position", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const { snapshot: selectedSnapshot } = await seedFailedAction(ledger);

  // Append an ordinary row after the resettable generation has failed but
  // strictly before that generation is actually reset, for a different
  // partial key. Its recorded_at is intentionally earlier than the reset's
  // observed_at (not tied) so this exercises the same-key structural
  // closure-visibility proof for the eventual fresh row while leaving the
  // closed-generation-vs-ordinary-row comparison unambiguous: distribution
  // history uses each record's true append position, not just its status.
  let snapshot = selectedSnapshot;
  const ordinary = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1", 98),
    history: historyProjection(snapshot.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(ordinary, { recorded_at: BEFORE_RESET_AT }),
  );
  assert.equal(snapshot.decisions[1].distribution.observed, 1);

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });
  assert.equal(afterReset.decisions[0].status, "superseded");
  assert.equal(afterReset.decisions[1].distribution.observed, 1);
  assert.deepEqual(historyProjection(afterReset.decisions), [
    {
      key: ordinary.key,
      step: ordinary.step,
      chosen: {
        candidate: ordinary.chosen.candidate,
        provider: ordinary.chosen.provider,
      },
      reason: null,
    },
  ]);

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
  assert.equal(fresh.distribution.observed, 1);
  const afterFresh = await ledger.record(
    afterReset,
    decisionRecordFromSelection(fresh, { recorded_at: RESET_AT }),
  );
  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(afterFresh.decisions[1].distribution.observed, 1);
  assert.equal(reloaded.decisions[2].distribution.observed, 1);
});

// Mirror of the test above: the reset happens first this time, and the
// following record is for an unrelated partial key whose recorded_at is
// tied exactly to the reset's observed_at — the review-0059 repro. Since no
// later generation of the reset key exists to prove closure structurally,
// distribution history for the tied cross-key record must fall back to the
// documented recorded_at >= supersededAt convention in
// distributionHistoryDecisions and treat the tie as closed, or record()
// throws "distribution.observed: must equal the actual preceding ledger
// window" the moment the tied row is committed.
test("distribution replay closes a generation reset before a tied-timestamp cross-key record", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const { snapshot } = await seedFailedAction(ledger);

  const afterReset = await ledger.resetAction(snapshot, {
    task: "task-0099",
    role: "implementer",
    attempt: 1,
    observed_at: RESET_AT,
  });
  assert.equal(afterReset.decisions[0].status, "superseded");

  // A fresh selection for a wholly different partial key, recorded with the
  // exact same timestamp as the reset above.
  const crossKey = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1", 98),
    history: historyProjection(afterReset.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  assert.equal(crossKey.distribution.observed, 0);
  const afterCrossKey = await ledger.record(
    afterReset,
    decisionRecordFromSelection(crossKey, { recorded_at: RESET_AT }),
  );
  assert.equal(afterCrossKey.decisions[1].distribution.observed, 0);

  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(reloaded.decisions[1].distribution.observed, 0);
});

test("distribution history uses the all-superseded closure rule without requiring reset events", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const selected = choose();
  let snapshot = await ledger.load();
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(selected, { recorded_at: NOW }),
  );
  snapshot = await ledger.updateOutcome(snapshot, {
    key: selected.key,
    step: 0,
    status: "dispatched",
    observed_at: DISPATCHED_AT,
  });

  const ordinary = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1", 98),
    history: historyProjection(snapshot.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  snapshot = await ledger.record(
    snapshot,
    decisionRecordFromSelection(ordinary, { recorded_at: FAILED_AT }),
  );
  assert.equal(snapshot.decisions[1].distribution.observed, 1);

  // The supersede transition's observed_at is strictly later than the
  // ordinary row's recorded_at above (not tied): that row was genuinely
  // recorded while the generation was still open, so replay must keep
  // counting it rather than resolve an accidental tie as closed.
  const afterSuperseded = await ledger.updateOutcome(snapshot, {
    key: selected.key,
    step: 0,
    status: "superseded",
    observed_at: RESET_AT,
  });
  assert.equal(afterSuperseded.decisions[0].events.length, 0);
  assert.deepEqual(historyProjection(afterSuperseded.decisions), [
    {
      key: ordinary.key,
      step: ordinary.step,
      chosen: {
        candidate: ordinary.chosen.candidate,
        provider: ordinary.chosen.provider,
      },
      reason: null,
    },
  ]);

  // A later decision for another partial key observes the closed generation
  // too; the shared rule remains global rather than becoming per-action.
  const postClose = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v1", 99),
    history: historyProjection(afterSuperseded.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  assert.equal(postClose.distribution.observed, 1);
  const afterPostClose = await ledger.record(
    afterSuperseded,
    decisionRecordFromSelection(postClose, { recorded_at: RESET_AT }),
  );

  const fresh = selectCandidate({
    config: config(),
    workload: workload(),
    key: key("policy-v2"),
    history: historyProjection(afterPostClose.decisions),
    implementerDecision: null,
    override: null,
    cooldowns: [],
    asOf: null,
  });
  assert.equal(fresh.distribution.observed, 2);
  await ledger.record(
    afterPostClose,
    decisionRecordFromSelection(fresh, { recorded_at: RESET_AT }),
  );
  const reloaded = await new RoutingDecisionLedger(file).load();
  assert.equal(reloaded.decisions[0].status, "superseded");
  assert.equal(reloaded.decisions[0].events.some((event) => event.kind === "reset"), false);
  assert.equal(reloaded.decisions[2].distribution.observed, 1);
  assert.equal(reloaded.decisions[3].distribution.observed, 2);
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
