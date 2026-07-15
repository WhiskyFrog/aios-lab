import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decisionKeyString,
  NoEligibleCandidateError,
  RoutingPolicyError,
  selectCandidate,
  validateDecisionKey,
} from "../src/routing-policy.js";
import {
  decisionRecordFromSelection,
  normalizeFailureReason,
  RoutingDecisionLedger,
  RoutingLedgerConflictError,
  RoutingLedgerError,
  validateDecisionRecord,
} from "../src/routing-ledger.js";

const NOW = "2026-07-14T05:00:00.000Z";
const EARLIER = "2026-07-14T04:59:59.000Z";
const LATER = "2026-07-14T05:00:01.000Z";

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
        selector: { task: "task-9001", plan: null },
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

function workload({
  role = "implementer",
  workKind = "implementation",
  minimumTier,
  lowerEligible = true,
  requiredCapabilities = ["filesystem"],
  estimatedTokens = 1_000,
  cost = "high",
  latency = "slow",
  complexity = "low",
  risk = "low",
  verification = "objective",
  approval = "not_required",
  retryCount = 0,
  history = {},
  uncertaintyFlags = [],
  strictPlanning = false,
  sourceOverrides = {},
} = {}) {
  const bytes = estimatedTokens * 4;
  const hintSource = "routing.hints.task:task-9001";
  const sources = {
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
    minimum_tier: lowerEligible ? "lower_tier_gate" : "routing.policy.high_tier",
    uncertainty_flags: "workload_evidence_validation",
    lower_tier: "documented_lower_tier_gate",
    diagnostics: "plan_and_history_validation",
    ...sourceOverrides,
  };
  const historyEvidence = {
    reviews_total: 0,
    changes_requested: 0,
    sessions_failed: 0,
    capacity_deferred: 0,
    ...history,
  };
  const rejectionReasons = [];
  if (role !== "implementer") rejectionReasons.push("role_not_implementer");
  if (workKind !== "implementation") rejectionReasons.push("work_not_bounded_implementation");
  if (complexity !== "low") rejectionReasons.push("complexity_not_low");
  if (risk !== "low") rejectionReasons.push("risk_not_low");
  if (bytes > 32_000) rejectionReasons.push("context_not_bounded");
  if (sources.required_capabilities === "default_unknown") {
    rejectionReasons.push("capabilities_not_explicit");
  }
  if (verification !== "objective") rejectionReasons.push("verification_not_objective");
  if (retryCount > 0 || historyEvidence.changes_requested > 0 || historyEvidence.sessions_failed > 0) {
    rejectionReasons.push("unresolved_failure_history");
  }
  if (uncertaintyFlags.some((flag) => flag !== "parent_plan_missing")) {
    rejectionReasons.push("safety_evidence_uncertain");
  }
  return {
    task_id: "task-9001",
    role,
    work_kind: workKind,
    parent_plan: null,
    complexity,
    risk,
    context_size: {
      bytes,
      estimated_tokens: estimatedTokens,
      band: bytes <= 8_000 ? "small" : bytes <= 32_000 ? "medium" : "large",
    },
    required_capabilities: requiredCapabilities,
    verification_burden: verification,
    budgets: { cost, latency },
    approval,
    retry: { count: retryCount, limit: 2 },
    history: historyEvidence,
    uncertainty_flags: uncertaintyFlags,
    minimum_tier: minimumTier ?? (lowerEligible ? "lower" : "high"),
    lower_tier: {
      eligible: lowerEligible,
      rejection_reasons: rejectionReasons,
    },
    sources,
    diagnostics: {
      strict_planning_contract: strictPlanning,
      plan_errors: [],
      history_errors: [],
    },
  };
}

function key({ role = "implementer", attempt = 1, revision = "policy-v1", task = "task-9001" } = {}) {
  return { task, role, attempt, policy_revision: revision };
}

function historyRow(selection) {
  return {
    key: selection.key,
    step: selection.step,
    chosen: {
      candidate: selection.chosen.candidate,
      provider: selection.chosen.provider,
    },
    reason: selection.step === 0 ? null : { code: "provider_error" },
  };
}

function choose(options = {}) {
  return selectCandidate({
    config: options.config ?? config(),
    workload: options.workload ?? workload(),
    key: options.key ?? key(),
    history: options.history ?? [],
    implementerDecision: options.implementerDecision ?? null,
  });
}

test("a bounded implementation selects the minimum sufficient lower tier", () => {
  const selected = choose();
  assert.equal(selected.chosen.candidate, "claude-lower");
  assert.equal(selected.chosen.tier, "lower");
  assert.equal(selected.minimum_tier, "lower");
  assert.equal(selected.fitness.tier_surplus, 0);
  assert.equal(selected.distribution.applied, true);
  assert.ok(Object.isFrozen(selected));
});

test("planning, unknown work, and a Reviewer without Implementer evidence stay high tier", () => {
  for (const workKind of ["planning", "unknown"]) {
    const conservativeConfig = config();
    conservativeConfig.hints[0].work_kind = workKind;
    const selected = choose({
      config: conservativeConfig,
      workload: workload({ workKind, minimumTier: "high", lowerEligible: false }),
    });
    assert.equal(selected.chosen.tier, "high");
    assert.ok(
      selected.considered
        .filter(({ tier }) => tier === "lower")
        .every(({ reasons }) => reasons.includes("tier_below_minimum")),
    );
  }

  const review = choose({
    workload: workload({ role: "reviewer", minimumTier: "high", lowerEligible: false }),
    key: key({ role: "reviewer" }),
  });
  assert.equal(review.chosen.tier, "high");
});

test("Reviewer chooses an equal-or-higher different provider and records same-provider exceptions", () => {
  const reviewerWorkload = workload({
    role: "reviewer",
    minimumTier: "high",
    lowerEligible: false,
  });
  const implementerDecision = {
    task: "task-9001",
    attempt: 1,
    candidate: "claude-high",
    provider: "claude",
    tier: "high",
  };
  const cross = choose({
    workload: reviewerWorkload,
    key: key({ role: "reviewer" }),
    implementerDecision,
  });
  assert.equal(cross.chosen.candidate, "codex-high");
  assert.equal(cross.same_provider_review, null);

  const sameConfig = config();
  sameConfig.candidates.find(({ id }) => id === "codex-high").enabled = false;
  const same = choose({
    config: sameConfig,
    workload: reviewerWorkload,
    key: key({ role: "reviewer" }),
    implementerDecision,
  });
  assert.equal(same.chosen.candidate, "claude-high");
  assert.deepEqual(same.same_provider_review.cross_provider_disqualified, [
    { candidate: "codex-high", reasons: ["candidate_disabled"] },
    { candidate: "codex-lower", reasons: ["role_ineligible", "tier_below_minimum", "tier_below_reviewer_floor"] },
  ]);

  for (const mutate of [
    (value) => {
      value.tier = "lower";
    },
    (value) => {
      value.provider = "codex";
    },
    (value) => {
      value.candidate = "missing-candidate";
    },
    (value) => {
      value.extra = true;
    },
  ]) {
    const forged = { ...implementerDecision };
    mutate(forged);
    assert.throws(
      () =>
        choose({
          workload: reviewerWorkload,
          key: key({ role: "reviewer" }),
          implementerDecision: forged,
        }),
      RoutingPolicyError,
    );
  }
});

test("hard capability, context, budget, Role, enabled, and tier gates beat distribution", () => {
  const gatedConfig = config();
  gatedConfig.candidates.find(({ id }) => id === "claude-lower").enabled = false;
  gatedConfig.hints[0].required_capabilities = ["shell"];
  gatedConfig.hints[0].cost_budget = "low";
  gatedConfig.hints[0].latency_budget = "fast";
  assert.throws(
    () =>
      choose({
        config: gatedConfig,
        workload: workload({
          requiredCapabilities: ["shell"],
          estimatedTokens: 100_000,
          cost: "low",
          latency: "fast",
          lowerEligible: false,
        }),
      }),
    (error) => {
      assert.ok(error instanceof NoEligibleCandidateError);
      const byId = new Map(error.considered.map((entry) => [entry.candidate, entry.reasons]));
      assert.ok(byId.get("claude-lower").includes("candidate_disabled"));
      assert.ok(byId.get("codex-lower").includes("capability_missing"));
      assert.ok(byId.get("codex-lower").includes("context_capacity_insufficient"));
      assert.ok(byId.get("claude-high").includes("cost_budget_exceeded"));
      assert.ok(byId.get("claude-high").includes("latency_budget_exceeded"));
      return true;
    },
  );
});

test("distribution converges with exact decimal weights", () => {
  const weighted = config();
  weighted.policy.provider_targets = [
    { provider: "claude", weight: 0.1 },
    { provider: "codex", weight: 0.2 },
  ];
  const history = [];
  const providers = [];
  let first;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const selected = choose({
      config: weighted,
      key: key({ attempt }),
      history,
    });
    first ??= selected;
    providers.push(selected.chosen.provider);
    history.push(historyRow(selected));
    for (const deficit of selected.distribution.deficits) {
      assert.match(deficit.numerator, /^-?[0-9]+$/);
      assert.match(deficit.denominator, /^[1-9][0-9]*$/);
    }
  }
  assert.deepEqual(providers, ["claude", "codex", "codex", "claude", "codex", "codex"]);

  const repeated = choose({
    config: weighted,
    key: first.key,
    workload: { ...workload(), task_id: first.key.task },
    history: [historyRow(first)],
  });
  assert.notEqual(repeated.step, first.step);
  assert.equal(first.chosen.provider, "claude");
});

test("distribution never beats a better fitness tuple", () => {
  const unequal = config();
  unequal.candidates.find(({ id }) => id === "codex-lower").latency_class = "slow";
  const history = Array.from({ length: 10 }, (_, index) => ({
    key: key({ task: `task-${String(9100 + index).padStart(4, "0")}` }),
    step: 0,
    chosen: { candidate: "claude-lower", provider: "claude" },
    reason: null,
  }));
  const selected = choose({ config: unequal, history });
  assert.equal(selected.chosen.candidate, "claude-lower");
  assert.equal(selected.distribution.applied, false);
  assert.deepEqual(selected.distribution.equivalent, ["claude-lower"]);
});

test("candidate id is the stable tie break inside the selected provider", () => {
  const tied = config();
  tied.candidates.push({
    ...structuredClone(tied.candidates.find(({ id }) => id === "claude-lower")),
    id: "aaa-claude-lower",
    model: "claude-configured-lower-alternate",
  });
  const selected = choose({ config: tied });
  assert.equal(selected.chosen.provider, "claude");
  assert.equal(selected.chosen.candidate, "aaa-claude-lower");
});

test("fallback steps are contiguous, bounded, and never reuse a candidate", () => {
  const history = [];
  const selected = [];
  for (let step = 0; step <= 2; step += 1) {
    const result = choose({ history });
    selected.push(result);
    history.push(historyRow(result));
    assert.equal(result.step, step);
  }
  assert.equal(new Set(selected.map(({ chosen }) => chosen.candidate)).size, 3);
  assert.equal(selected[2].fallback.available, false);
  assert.throws(() => choose({ history }), /fallback limit 2 is exhausted/);
  assert.throws(
    () =>
      choose({
        history: [{ ...history[0], step: 1, reason: { code: "provider_error" } }],
      }),
    /non-contiguous or out-of-order steps/,
  );
});

test("history is canonical and rejects forged, duplicate, or conflicting rows", () => {
  const initial = historyRow(choose());

  const forgedProvider = structuredClone(initial);
  forgedProvider.chosen.provider = "codex";
  assert.throws(
    () => choose({ key: key({ attempt: 2 }), history: [forgedProvider] }),
    /provider: must match the configured candidate/,
  );

  const extra = { ...structuredClone(initial), model: "hidden" };
  assert.throws(
    () => choose({ key: key({ attempt: 2 }), history: [extra] }),
    /history\[0\]\.model: is not allowed/,
  );

  assert.throws(
    () => choose({ key: key({ attempt: 2 }), history: [initial, structuredClone(initial)] }),
    /duplicates .* step 0/,
  );

  const otherRevision = structuredClone(initial);
  otherRevision.key.policy_revision = "policy-v2";
  assert.throws(
    () => choose({ key: key({ attempt: 2 }), history: [initial, otherRevision] }),
    /conflicts with another policy revision/,
  );
  assert.throws(
    () => choose({ history: [otherRevision] }),
    /uses another policy revision/,
  );

  const fallback = {
    key: initial.key,
    step: 1,
    chosen: { candidate: "codex-lower", provider: "codex" },
    reason: { code: "timeout" },
  };
  assert.throws(
    () => choose({ key: key({ attempt: 2 }), history: [fallback, initial] }),
    /non-contiguous or out-of-order/,
  );
});

test("per-Task escalation use is exposed and bounded across action keys", () => {
  const escalationRows = [8, 9].flatMap((attempt) => [
    {
      key: key({ attempt }),
      step: 0,
      chosen: { candidate: "claude-lower", provider: "claude" },
      reason: null,
    },
    {
      key: key({ attempt }),
      step: 1,
      chosen: { candidate: "codex-lower", provider: "codex" },
      reason: { code: "context_failure" },
    },
  ]);
  const selected = choose({ history: escalationRows });
  assert.deepEqual(selected.escalation, { used: 2, limit: 2, available: false });

  assert.throws(
    () =>
      choose({
        history: [
          ...escalationRows,
          {
            key: key({ attempt: 10 }),
            step: 0,
            chosen: { candidate: "claude-lower", provider: "claude" },
            reason: null,
          },
          {
            key: key({ attempt: 10 }),
            step: 1,
            chosen: { candidate: "codex-lower", provider: "codex" },
            reason: { code: "review_rejected" },
          },
        ],
      }),
    /exceeds escalation limit 2/,
  );
});

test("lower-tier eligibility rejects contradictory or extra normalized evidence", () => {
  const contradictions = [
    (value) => {
      value.risk = "high";
    },
    (value) => {
      value.approval = "required";
    },
    (value) => {
      value.verification_burden = "unknown";
    },
    (value) => {
      value.retry.count = 1;
    },
    (value) => {
      value.history.changes_requested = 1;
    },
    (value) => {
      value.uncertainty_flags.push("risk_unknown");
    },
    (value) => {
      value.diagnostics.history_errors.push("invalid review");
    },
    (value) => {
      value.sources.required_capabilities = "default_unknown";
    },
    (value) => {
      value.diagnostics.strict_planning_contract = true;
    },
  ];
  for (const contradict of contradictions) {
    const context = workload();
    contradict(context);
    assert.throws(() => choose({ workload: context }), RoutingPolicyError);
  }

  assert.throws(
    () => choose({ workload: { ...workload(), prompt: "hidden" } }),
    /workload.prompt: is not allowed/,
  );
  const extraNested = workload();
  extraNested.sources.environment = "PATH=hidden";
  assert.throws(() => choose({ workload: extraNested }), /sources.environment: is not allowed/);
  const unsafeSource = workload();
  unsafeSource.sources.risk = "api_key=topsecret";
  assert.throws(() => choose({ workload: unsafeSource }), /not a recognized normalized source label/);

  const absentHintConfig = config();
  absentHintConfig.hints = [];
  assert.throws(
    () => choose({ config: absentHintConfig }),
    /hint source routing\.hints\.task:task-9001 is absent/,
  );

  const wrongTaskConfig = config();
  wrongTaskConfig.hints[0].selector.task = "task-9999";
  const wrongTask = workload({
    sourceOverrides: Object.fromEntries(
      Object.entries(workload().sources).map(([name, source]) => [
        name,
        source.replaceAll("task-9001", "task-9999"),
      ]),
    ),
  });
  assert.throws(
    () => choose({ config: wrongTaskConfig, workload: wrongTask }),
    /does not identify task-9001/,
  );

  const mismatchedHint = config();
  mismatchedHint.hints[0].risk = "medium";
  assert.throws(
    () => choose({ config: mismatchedHint }),
    /workload.risk: does not match/,
  );

  const falseReasons = workload();
  falseReasons.lower_tier.rejection_reasons = ["risk_not_low"];
  assert.throws(
    () => choose({ workload: falseReasons }),
    /does not match the failed normalized gates/,
  );
});

test("every normalized lower-tier rejection code is asserted", () => {
  const scenarios = [
    {
      code: "role_not_implementer",
      config: config(),
      key: key({ role: "reviewer" }),
      workload: workload({ role: "reviewer", lowerEligible: false }),
    },
    {
      code: "work_not_bounded_implementation",
      config: (() => {
        const value = config();
        value.hints[0].work_kind = "planning";
        return value;
      })(),
      workload: workload({ workKind: "planning", lowerEligible: false }),
    },
    {
      code: "complexity_not_low",
      config: (() => {
        const value = config();
        value.hints[0].complexity = "high";
        return value;
      })(),
      workload: workload({ complexity: "high", lowerEligible: false }),
    },
    {
      code: "risk_not_low",
      config: (() => {
        const value = config();
        value.hints[0].risk = "high";
        return value;
      })(),
      workload: workload({ risk: "high", lowerEligible: false }),
    },
    {
      code: "context_not_bounded",
      config: config(),
      workload: workload({ estimatedTokens: 100_000, lowerEligible: false }),
    },
    {
      code: "verification_not_objective",
      config: (() => {
        const value = config();
        value.hints[0].verification = "subjective";
        return value;
      })(),
      workload: workload({ verification: "subjective", lowerEligible: false }),
    },
    {
      code: "unresolved_failure_history",
      config: config(),
      workload: workload({
        risk: "high",
        retryCount: 1,
        lowerEligible: false,
        sourceOverrides: { risk: "task.retry" },
      }),
    },
    {
      code: "safety_evidence_uncertain",
      config: config(),
      workload: workload({
        uncertaintyFlags: ["parent_plan_ambiguous"],
        lowerEligible: false,
      }),
    },
  ];
  for (const scenario of scenarios) {
    const selected = choose({
      config: scenario.config,
      key: scenario.key,
      workload: scenario.workload,
    });
    assert.ok(scenario.workload.lower_tier.rejection_reasons.includes(scenario.code));
    assert.equal(selected.minimum_tier, "high");
  }

  const noHintConfig = config();
  noHintConfig.hints = [];
  const noHint = workload({
    workKind: "unknown",
    risk: "unknown",
    verification: "unknown",
    requiredCapabilities: [],
    uncertaintyFlags: [
      "work_kind_unknown",
      "risk_unknown",
      "required_capabilities_unknown",
      "verification_unknown",
    ],
    lowerEligible: false,
    cost: "high",
    latency: "slow",
    sourceOverrides: {
      work_kind: "default",
      complexity: "task.structure",
      risk: "default",
      required_capabilities: "default_unknown",
      verification_burden: "default_unknown",
      budgets: "routing.policy.default_budgets",
    },
  });
  const selected = choose({ config: noHintConfig, workload: noHint });
  assert.ok(noHint.lower_tier.rejection_reasons.includes("capabilities_not_explicit"));
  assert.equal(selected.minimum_tier, "high");
});

test("decision keys are strict, stable, and policy revisions are explicit", () => {
  const valid = validateDecisionKey(key());
  assert.equal(decisionKeyString(valid), "task-9001:implementer:1:policy-v1");
  assert.throws(() => validateDecisionKey({ ...key(), extra: true }), /extra: is not allowed/);
  assert.throws(() => validateDecisionKey({ ...key(), attempt: 0 }), /positive safe integer/);
  assert.throws(() => validateDecisionKey({ ...key(), role: "approver" }), /unknown value/);
  const first = choose();
  const second = choose();
  assert.deepEqual(second, first);
});

async function temporaryLedger(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".aios", "runtime", "routing-decisions.json");
  await mkdir(path.dirname(file), { recursive: true });
  return {
    file,
    ledger: new RoutingDecisionLedger(file),
  };
}

function initialRecord(selection = choose(), options = {}) {
  return decisionRecordFromSelection(selection, {
    recorded_at: options.recorded_at ?? NOW,
    observed_at: options.observed_at ?? NOW,
    status: options.status ?? "selected",
    reason: options.reason ?? null,
    override: options.override ?? selection?.override ?? null,
  });
}

function attachedOverride() {
  return {
    candidate: "claude-lower",
    source: "cli",
    selector: { task: "task-9001", role: "implementer" },
    allow_fallback: false,
    policy_winner: {
      candidate: "claude-lower",
      provider: "claude",
      model: "claude-configured-lower",
      tier: "lower",
    },
    displaced_budgets: [],
    displaced_rationale: "override matches the normal policy winner",
    displaced_config_candidate: null,
    hard_gates_passed: true,
  };
}

test("decision ledger records atomically, resolves exact keys, and projects sanitized evidence", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const empty = await ledger.load();
  assert.equal(empty.raw, null);
  const record = initialRecord();
  const recorded = await ledger.record(empty, record);
  assert.equal(recorded.decisions.length, 1);
  assert.equal((await ledger.resolveKey(record.key)).active.chosen.candidate, "claude-lower");
  assert.equal((await ledger.latestDecision("task-9001", "implementer")).step, 0);
  assert.deepEqual(await ledger.windowCounts(20), {
    window: 20,
    observed: 1,
    counts: [{ provider: "claude", count: 1 }],
  });
  const projection = await ledger.dashboardProjection();
  assert.equal(projection.decisions[0].chosen.model, "claude-configured-lower");
  assert.equal(projection.decisions[0].advanced_by, null);
  assert.equal(projection.summary.window, 20);
  assert.equal(projection.summary.observed, 1);
  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /command|environment|continuation|prompt/);
  assert.deepEqual(await ledger.record(recorded, record), recorded);
});

test("ledger compare-and-swap rejects stale writers and immutable rewrites", async (t) => {
  const { ledger } = await temporaryLedger(t);
  const left = await ledger.load();
  const right = await ledger.load();
  const record = initialRecord();
  const recorded = await ledger.record(left, record);
  await assert.rejects(ledger.record(right, record), RoutingLedgerConflictError);

  const changed = structuredClone(record);
  changed.recorded_at = LATER;
  changed.observed_at = LATER;
  await assert.rejects(ledger.record(recorded, changed), /Refusing to rewrite/);

  const changedStatus = structuredClone(record);
  changedStatus.status = "dispatched";
  await assert.rejects(ledger.record(recorded, changedStatus), /must be recorded as selected/);

  const otherRevision = initialRecord(
    choose({ key: key({ revision: "policy-v2" }) }),
  );
  await assert.rejects(ledger.record(recorded, otherRevision), /Policy revision mismatch/);
  await assert.rejects(ledger.resolveKey(key({ revision: "policy-v2" })), /another policy revision/);
});

test("ledger serializes overlapping writers and rejects fabricated snapshots", async (t) => {
  const { ledger } = await temporaryLedger(t);
  const snapshot = await ledger.load();
  const first = initialRecord();
  const second = initialRecord(choose({ key: key({ attempt: 2 }) }));
  const writes = await Promise.allSettled([
    ledger.record(snapshot, first),
    ledger.record(snapshot, second),
  ]);
  assert.equal(writes.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = writes.find(({ status }) => status === "rejected");
  assert.ok(rejected.reason instanceof RoutingLedgerConflictError);
  assert.equal((await ledger.load()).decisions.length, 1);

  const current = await ledger.load();
  const fabricated = {
    ...current,
    decisions: current.decisions[0].key.attempt === 1 ? [second] : [first],
  };
  await assert.rejects(
    ledger.record(fabricated, current.decisions[0]),
    /fields do not correspond to snapshot.raw/,
  );
});

test("ledger outcome and override updates move forward and preserve immutable evidence", async (t) => {
  const { ledger } = await temporaryLedger(t);
  const record = initialRecord();
  let state = await ledger.record(await ledger.load(), record);
  await assert.rejects(
    ledger.updateOutcome(state, {
      key: record.key,
      step: 0,
      status: "completed",
      observed_at: LATER,
    }),
    /cannot move from selected to completed/,
  );
  await assert.rejects(
    ledger.updateOutcome(state, {
      key: record.key,
      step: 0,
      status: "dispatched",
      observed_at: EARLIER,
    }),
    /cannot move backward/,
  );
  state = await ledger.attachOverride(state, {
    key: record.key,
    step: 0,
    override: attachedOverride(),
    observed_at: NOW,
  });
  state = await ledger.updateOutcome(state, {
    key: record.key,
    step: 0,
    status: "dispatched",
    observed_at: LATER,
  });
  await assert.rejects(
    ledger.updateOutcome(state, {
      key: record.key,
      step: 0,
      status: "selected",
      observed_at: LATER,
    }),
    /cannot move/,
  );
  state = await ledger.updateOutcome(state, {
    key: record.key,
    step: 0,
    status: "completed",
    observed_at: LATER,
  });
  assert.equal(state.decisions[0].status, "completed");
  await assert.rejects(
    ledger.updateOutcome(state, {
      key: record.key,
      step: 0,
      status: "failed",
      observed_at: LATER,
    }),
    /cannot move from completed to failed/,
  );
  assert.equal(state.decisions[0].override.source, "cli");
  await assert.rejects(
    ledger.attachOverride(state, {
      key: record.key,
      step: 0,
      override: attachedOverride(),
      observed_at: LATER,
    }),
    /already has an override/,
  );

  const withoutOverride = await temporaryLedger(t);
  const secondRecord = initialRecord();
  let secondState = await withoutOverride.ledger.record(
    await withoutOverride.ledger.load(),
    secondRecord,
  );
  secondState = await withoutOverride.ledger.updateOutcome(secondState, {
    key: secondRecord.key,
    step: 0,
    status: "dispatched",
    observed_at: LATER,
  });
  await assert.rejects(
    withoutOverride.ledger.attachOverride(secondState, {
      key: secondRecord.key,
      step: 0,
      override: attachedOverride(),
      observed_at: LATER,
    }),
    /before dispatch/,
  );
});

test("failure diagnostics are bounded and redact common credentials and local paths", () => {
  const reason = normalizeFailureReason(
    "provider_error",
    `Bearer secret-token api_key=topsecret sk-abcdefghijk C:\\Users\\alice\\worker /home/alice/worker\n${"x".repeat(400)}`,
  );
  assert.equal(reason.code, "provider_error");
  assert.ok(reason.diagnostic.length <= 240);
  assert.doesNotMatch(reason.diagnostic, /secret-token|topsecret|sk-abcdefghijk|alice/);
  assert.match(reason.diagnostic, /\[redacted\]|\[path\]/);
  assert.throws(() => normalizeFailureReason("mystery", "x"), /unknown code/);

  const first = choose();
  const fallback = choose({ history: [historyRow(first)] });
  const record = initialRecord(fallback, {
    reason: {
      code: "provider_error",
      diagnostic: "api_key=topsecret C:\\Users\\alice\\worker",
    },
  });
  assert.doesNotMatch(JSON.stringify(record), /topsecret|alice/);

  const unsafe = structuredClone(record);
  unsafe.reason.diagnostic = "token=topsecret";
  assert.throws(() => validateDecisionRecord(unsafe), /must be normalized, sanitized/);
});

test("ledger source evidence is closed and cannot carry prompt, environment, or secrets", () => {
  const record = initialRecord();
  const extra = structuredClone(record);
  extra.workload.sources.prompt = "Task body";
  assert.throws(() => validateDecisionRecord(extra), /sources.prompt: is not allowed/);

  for (const unsafe of ["api_key=topsecret", "node worker.mjs --prompt hidden"] ) {
    const value = structuredClone(record);
    value.workload.sources.risk = unsafe;
    assert.throws(() => validateDecisionRecord(value), /not a recognized normalized source label/);
  }

  const unsafeCatalog = config();
  unsafeCatalog.candidates[0].model = "node worker.mjs --prompt topsecret";
  assert.throws(() => choose({ config: unsafeCatalog }), /model: has an invalid value/);

  const unsafeModel = structuredClone(record);
  unsafeModel.considered[0].model = "api_key=topsecret";
  if (unsafeModel.chosen.candidate === unsafeModel.considered[0].candidate) {
    unsafeModel.chosen.model = unsafeModel.considered[0].model;
  }
  assert.throws(
    () => validateDecisionRecord(unsafeModel),
    /model.*bounded, credential-safe provider model identifier/,
  );
});

test("credential, token, URL, and local-path model ids fail before storage", async (t) => {
  const unsafeModels = [
    "sk-abcdefghijk",
    "ghp_abcdefghijk",
    "AKIAABCDEFGHIJKLMNOP",
    "AIzaabcdefghijklmnop",
    "token:topsecret",
    "https://provider.example/model",
    "C:/Users/alice/model",
  ];
  for (const model of unsafeModels) {
    const unsafeCatalog = config();
    unsafeCatalog.candidates[0].model = model;
    assert.throws(
      () => choose({ config: unsafeCatalog }),
      /model: resembles a credential, token, URL, or local path|model: has an invalid value/,
    );

    const unsafeRecord = structuredClone(initialRecord());
    unsafeRecord.considered[0].model = model;
    assert.throws(
      () => validateDecisionRecord(unsafeRecord),
      /credential-safe provider model identifier/,
    );
  }

  const { file, ledger } = await temporaryLedger(t);
  const unsafeRecord = structuredClone(initialRecord());
  unsafeRecord.considered[0].model = "sk-abcdefghijk";
  await assert.rejects(ledger.record(await ledger.load(), unsafeRecord));
  await assert.rejects(readFile(file, "utf8"), (error) => error?.code === "ENOENT");
});

test("strict ledger validation closes workload and distribution cross-field invariants", () => {
  const malformedWorkload = structuredClone(initialRecord());
  malformedWorkload.workload.risk = "banana";
  assert.throws(() => validateDecisionRecord(malformedWorkload), /risk: has an unknown value/);

  const negativeTarget = structuredClone(initialRecord());
  negativeTarget.distribution.counts[0].weight = -1;
  assert.throws(() => validateDecisionRecord(negativeTarget), /weight: must be positive/);

  const badTotal = structuredClone(initialRecord());
  badTotal.distribution.counts[0].count += 1;
  assert.throws(() => validateDecisionRecord(badTotal), /must sum to observed decisions/);

  const duplicateProvider = structuredClone(initialRecord());
  duplicateProvider.distribution.counts[1].provider =
    duplicateProvider.distribution.counts[0].provider;
  assert.throws(() => validateDecisionRecord(duplicateProvider), /duplicates provider|ordered by provider/);

  const unequal = config();
  unequal.candidates.find(({ id }) => id === "codex-lower").latency_class = "slow";
  const impossibleChange = initialRecord(choose({ config: unequal }));
  impossibleChange.distribution.changed_winner = true;
  assert.throws(
    () => validateDecisionRecord(impossibleChange),
    /must identify a change from the fitness winner/,
  );
});

test("ledger replays preceding decisions and rejects a non-winning candidate", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const firstSelection = choose();
  const firstRecord = initialRecord(firstSelection);
  let state = await ledger.record(await ledger.load(), firstRecord);

  const actualHistory = [historyRow(firstSelection)];
  const secondSelection = choose({ key: key({ attempt: 2 }), history: actualHistory });
  const secondRecord = initialRecord(secondSelection, {
    recorded_at: LATER,
    observed_at: LATER,
  });
  state = await ledger.record(state, secondRecord);
  assert.equal(state.decisions[1].distribution.observed, 1);
  assert.equal(state.decisions[1].chosen.provider, "codex");

  const wrongWinner = structuredClone(secondRecord);
  const claude = wrongWinner.considered.find(
    (entry) => entry.candidate === "claude-lower",
  );
  wrongWinner.chosen = {
    candidate: claude.candidate,
    provider: claude.provider,
    model: claude.model,
    tier: claude.tier,
  };
  wrongWinner.distribution.changed_winner = false;
  assert.throws(
    () => validateDecisionRecord(wrongWinner),
    /greatest provider deficit/,
  );

  const fakePrior = {
    key: key({ attempt: 9 }),
    step: 0,
    chosen: { candidate: "codex-lower", provider: "codex" },
    reason: null,
  };
  const fabricatedSelection = choose({
    key: key({ attempt: 3 }),
    history: [fakePrior],
  });
  const fabricatedRecord = initialRecord(fabricatedSelection, {
    recorded_at: "2026-07-14T05:00:02.000Z",
    observed_at: "2026-07-14T05:00:02.000Z",
  });
  assert.doesNotThrow(() => validateDecisionRecord(fabricatedRecord));
  await assert.rejects(
    ledger.record(state, fabricatedRecord),
    /actual preceding ledger window|does not match preceding ledger decisions/,
  );

  const malformed = {
    schema: "aios.routing-decisions/v1",
    updated_at: fabricatedRecord.observed_at,
    decisions: [firstRecord, fabricatedRecord],
  };
  await writeFile(file, `${JSON.stringify(malformed)}\n`, "utf8");
  await assert.rejects(ledger.load(), /does not match preceding ledger decisions/);
});

test("ledger recomputes lower-tier evidence instead of trusting eligibility claims", () => {
  const record = initialRecord();
  const fabricated = structuredClone(record);
  fabricated.workload.risk = "high";
  assert.throws(
    () => validateDecisionRecord(fabricated),
    /rejection_reasons: does not match normalized evidence/,
  );
});

test("strict decision validation rejects mismatched chosen and fitness evidence", () => {
  const record = initialRecord();
  const chosen = structuredClone(record);
  chosen.chosen.model = "invented-model";
  assert.throws(() => validateDecisionRecord(chosen), /must match the considered candidate/);

  const fitness = structuredClone(record);
  fitness.fitness.vector[1] -= 1;
  assert.throws(() => validateDecisionRecord(fitness), /must match the named fitness components/);

  const unknown = structuredClone(record);
  unknown.secret = "not allowed";
  assert.throws(() => validateDecisionRecord(unknown), /secret: is not allowed/);

  assert.throws(
    () => initialRecord(undefined, { recorded_at: NOW, observed_at: EARLIER }),
    /cannot be before recorded_at/,
  );
  assert.throws(
    () => initialRecord(undefined, { status: "dispatched" }),
    /must be selected before dispatch/,
  );
});

test("malformed ledgers fail closed without being overwritten", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  await writeFile(file, "{bad json", "utf8");
  await assert.rejects(ledger.load(), RoutingLedgerError);
  assert.equal(await readFile(file, "utf8"), "{bad json");
});

test("ledger updated_at must match the latest observed decision", async (t) => {
  const { file, ledger } = await temporaryLedger(t);
  const malformed = {
    schema: "aios.routing-decisions/v1",
    updated_at: LATER,
    decisions: [initialRecord()],
  };
  await writeFile(file, `${JSON.stringify(malformed)}\n`, "utf8");
  await assert.rejects(ledger.load(), /must equal the latest decision observed_at/);
});
