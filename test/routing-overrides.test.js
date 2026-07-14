import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import {
  normalizeRouteOverrides,
  parseRouteOverride,
  RoutingConfigError,
  validateRouteOverridesForConfig,
} from "../src/routing.js";
import { RoutingPolicyError, selectCandidate } from "../src/routing-policy.js";
import {
  decisionRecordFromSelection,
  normalizeFailureReason,
  RoutingDecisionLedger,
  routingDecisionsPath,
  validateDecisionRecord,
} from "../src/routing-ledger.js";
import {
  resolveRouteOverride,
  RoutedAssignmentResolver,
} from "../src/routing-dispatch.js";
import { FileAssignmentResolver } from "../src/workers.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(projectRoot, "fixtures", "command-worker.js");
const cli = path.join(projectRoot, "src", "cli.js");
const NOW = "2026-07-14T06:00:00.000Z";

// --- pure selection helpers (mirrors routing-policy.test.js fixtures) ------

function policyConfig() {
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

function policyWorkload({
  role = "implementer",
  workKind = "implementation",
  minimumTier,
  lowerEligible = true,
  requiredCapabilities = ["filesystem"],
  estimatedTokens = 1_000,
  cost = "high",
  latency = "slow",
} = {}) {
  const bytes = estimatedTokens * 4;
  const hintSource = "routing.hints.task:task-9001";
  const rejectionReasons = [];
  if (role !== "implementer") rejectionReasons.push("role_not_implementer");
  if (workKind !== "implementation") rejectionReasons.push("work_not_bounded_implementation");
  if (bytes > 32_000) rejectionReasons.push("context_not_bounded");
  return {
    task_id: "task-9001",
    role,
    work_kind: workKind,
    parent_plan: null,
    complexity: "low",
    risk: "low",
    context_size: {
      bytes,
      estimated_tokens: estimatedTokens,
      band: bytes <= 8_000 ? "small" : bytes <= 32_000 ? "medium" : "large",
    },
    required_capabilities: requiredCapabilities,
    verification_burden: "objective",
    budgets: { cost, latency },
    approval: "not_required",
    retry: { count: 0, limit: 2 },
    history: {
      reviews_total: 0,
      changes_requested: 0,
      sessions_failed: 0,
      capacity_deferred: 0,
    },
    uncertainty_flags: [],
    minimum_tier: minimumTier ?? (lowerEligible ? "lower" : "high"),
    lower_tier: { eligible: lowerEligible, rejection_reasons: rejectionReasons },
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
      minimum_tier: lowerEligible ? "lower_tier_gate" : "routing.policy.high_tier",
      uncertainty_flags: "workload_evidence_validation",
      lower_tier: "documented_lower_tier_gate",
      diagnostics: "plan_and_history_validation",
    },
    diagnostics: {
      strict_planning_contract: false,
      plan_errors: [],
      history_errors: [],
    },
  };
}

function policyKey({ role = "implementer", attempt = 1 } = {}) {
  return { task: "task-9001", role, attempt, policy_revision: "policy-v1" };
}

function cliOverrideInput(candidate, { task = "task-9001", role = "implementer" } = {}) {
  return {
    candidate,
    source: "cli",
    selector: { task, role },
    allow_fallback: false,
    displaced_config_candidate: null,
  };
}

async function temporaryLedger(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-override-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "routing-decisions.json");
  return { file, ledger: new RoutingDecisionLedger(file) };
}

// --- override flag grammar ---------------------------------------------------

test("route override values parse the documented selector grammar", () => {
  assert.deepEqual(parseRouteOverride("task-0001:implementer=claude-high"), {
    selector: { task: "task-0001", role: "implementer" },
    candidate: "claude-high",
  });
  assert.deepEqual(parseRouteOverride(" *:reviewer=codex-high "), {
    selector: { task: "*", role: "reviewer" },
    candidate: "codex-high",
  });

  const failures = [
    ["", /must be shaped <task-selector>:<role>=<candidate-id>/],
    ["*:implementer", /must be shaped/],
    ["claude-high", /must be shaped/],
    ["task-1:implementer=claude-high", /invalid Task selector task-1/],
    ["tasks:implementer=claude-high", /invalid Task selector tasks/],
    ["*:approver=human", /cannot target approver.*outside model routing/],
    ["*:builder=claude-high", /unknown Role builder.*implementer or reviewer/],
    ["*:implementer=Bad", /invalid candidate id Bad/],
    ["*:implementer=", /must be shaped/],
  ];
  for (const [value, expected] of failures) {
    assert.throws(() => parseRouteOverride(value), RoutingConfigError);
    assert.throws(() => parseRouteOverride(value), expected, value);
  }

  assert.throws(
    () =>
      normalizeRouteOverrides([
        "task-0001:implementer=claude-high",
        "task-0001:implementer=codex-high",
      ]),
    /duplicate or conflicting rules for selector task-0001:implementer/,
  );
  assert.throws(
    () => normalizeRouteOverrides(["*:reviewer=claude-high", "*:reviewer=claude-high"]),
    /duplicate or conflicting rules for selector \*:reviewer/,
  );
  assert.equal(
    normalizeRouteOverrides(["task-0001:implementer=a", "*:implementer=b"]).length,
    2,
  );
});

test("route overrides validate against the execution config before any launch", () => {
  const routing = { kind: "routing", config: policyConfig() };
  const overrides = normalizeRouteOverrides(["*:implementer=claude-lower"]);
  validateRouteOverridesForConfig(overrides, routing);
  validateRouteOverridesForConfig([], { kind: "assignments", config: {} });

  assert.throws(
    () => validateRouteOverridesForConfig(overrides, { kind: "assignments", config: {} }),
    /requires an aios\.routing\/v1 execution configuration.*aios\.assignments\/v1/,
  );
  assert.throws(
    () =>
      validateRouteOverridesForConfig(
        normalizeRouteOverrides(["*:implementer=missing-candidate"]),
        routing,
      ),
    /candidate missing-candidate, which is not in the routing catalog/,
  );
  assert.throws(
    () =>
      validateRouteOverridesForConfig(
        normalizeRouteOverrides(["*:reviewer=claude-lower"]),
        routing,
      ),
    /candidate claude-lower is ineligible for Role reviewer/,
  );
});

// --- pure selection with an override ----------------------------------------

test("an override displaces the policy winner and records complete audit evidence", async (t) => {
  const selected = selectCandidate({
    config: policyConfig(),
    workload: policyWorkload(),
    key: policyKey(),
    override: cliOverrideInput("codex-lower"),
  });
  assert.equal(selected.chosen.candidate, "codex-lower");
  assert.deepEqual(selected.override, {
    candidate: "codex-lower",
    source: "cli",
    selector: { task: "task-9001", role: "implementer" },
    allow_fallback: false,
    displaced_config_candidate: null,
    policy_winner: {
      candidate: "claude-lower",
      provider: "claude",
      model: "claude-configured-lower",
      tier: "lower",
    },
    displaced_budgets: [],
    displaced_rationale: "override displaced normal policy winner claude-lower",
    hard_gates_passed: true,
  });
  assert.ok(Object.isFrozen(selected.override));

  const { ledger } = await temporaryLedger(t);
  const record = decisionRecordFromSelection(selected, { recorded_at: NOW });
  const state = await ledger.record(await ledger.load(), record);
  assert.equal(state.decisions[0].override.source, "cli");
  assert.equal(state.decisions[0].override.policy_winner.candidate, "claude-lower");
  assert.equal(state.decisions[0].chosen.candidate, "codex-lower");
});

test("an override that matches the policy winner records the matching rationale", () => {
  const selected = selectCandidate({
    config: policyConfig(),
    workload: policyWorkload(),
    key: policyKey(),
    override: cliOverrideInput("claude-lower"),
  });
  assert.equal(selected.chosen.candidate, "claude-lower");
  assert.equal(
    selected.override.displaced_rationale,
    "override matches the normal policy winner",
  );
});

test("an override may displace cost and latency budget preference", async (t) => {
  const config = policyConfig();
  config.hints[0].cost_budget = "low";
  config.hints[0].latency_budget = "fast";
  const selected = selectCandidate({
    config,
    workload: policyWorkload({ cost: "low", latency: "fast" }),
    key: policyKey(),
    override: cliOverrideInput("claude-high"),
  });
  assert.equal(selected.chosen.candidate, "claude-high");
  assert.deepEqual(selected.override.displaced_budgets, [
    "cost_budget_exceeded",
    "latency_budget_exceeded",
  ]);
  assert.equal(
    selected.considered.find(({ candidate }) => candidate === "claude-high").eligible,
    false,
  );
  const { ledger } = await temporaryLedger(t);
  const record = decisionRecordFromSelection(selected, { recorded_at: NOW });
  const state = await ledger.record(await ledger.load(), record);
  assert.deepEqual(state.decisions[0].override.displaced_budgets, [
    "cost_budget_exceeded",
    "latency_budget_exceeded",
  ]);
});

test("an unsafe override fails closed and names every violated hard gate", () => {
  const disabled = policyConfig();
  disabled.candidates.find(({ id }) => id === "codex-lower").enabled = false;
  assert.throws(
    () =>
      selectCandidate({
        config: disabled,
        workload: policyWorkload(),
        key: policyKey(),
        override: cliOverrideInput("codex-lower"),
      }),
    /violates hard safety gates: candidate_disabled/,
  );

  const capabilityConfig = policyConfig();
  capabilityConfig.hints[0].required_capabilities = ["shell"];
  assert.throws(
    () =>
      selectCandidate({
        config: capabilityConfig,
        workload: policyWorkload({ requiredCapabilities: ["shell"] }),
        key: policyKey(),
        override: cliOverrideInput("codex-lower"),
      }),
    /violates hard safety gates: capability_missing/,
  );

  const planningConfig = policyConfig();
  planningConfig.hints[0].work_kind = "planning";
  assert.throws(
    () =>
      selectCandidate({
        config: planningConfig,
        workload: policyWorkload({ workKind: "planning", lowerEligible: false }),
        key: policyKey(),
        override: cliOverrideInput("codex-lower"),
      }),
    /violates hard safety gates: tier_below_minimum/,
  );

  assert.throws(
    () =>
      selectCandidate({
        config: policyConfig(),
        workload: policyWorkload({ estimatedTokens: 100_000, lowerEligible: false }),
        key: policyKey(),
        override: cliOverrideInput("codex-lower"),
      }),
    /violates hard safety gates: context_capacity_insufficient, tier_below_minimum/,
  );

  const reviewerConfig = policyConfig();
  reviewerConfig.candidates.push({
    id: "codex-review-lower",
    provider: "codex",
    model: "codex-review-lower-model",
    tier: "lower",
    roles: ["reviewer"],
    command: [process.execPath, "codex-worker.mjs", "--review"],
    enabled: true,
    context_limit: 64_000,
    capabilities: ["filesystem", "shell"],
    cost_class: "low",
    latency_class: "fast",
  });
  assert.throws(
    () =>
      selectCandidate({
        config: reviewerConfig,
        workload: policyWorkload({ role: "reviewer", lowerEligible: false }),
        key: policyKey({ role: "reviewer" }),
        implementerDecision: {
          task: "task-9001",
          attempt: 1,
          candidate: "claude-high",
          provider: "claude",
          tier: "high",
        },
        override: cliOverrideInput("codex-review-lower", { role: "reviewer" }),
      }),
    /violates hard safety gates: tier_below_minimum, tier_below_reviewer_floor/,
  );

  assert.throws(
    () =>
      selectCandidate({
        config: policyConfig(),
        workload: policyWorkload({ role: "reviewer", lowerEligible: false }),
        key: policyKey({ role: "reviewer" }),
        override: cliOverrideInput("claude-lower", { role: "reviewer" }),
      }),
    /candidate claude-lower is ineligible for Role reviewer/,
  );
});

test("an override never applies past the initial selection step", () => {
  const first = selectCandidate({
    config: policyConfig(),
    workload: policyWorkload(),
    key: policyKey(),
  });
  assert.throws(
    () =>
      selectCandidate({
        config: policyConfig(),
        workload: policyWorkload(),
        key: policyKey(),
        history: [
          {
            key: first.key,
            step: 0,
            chosen: {
              candidate: first.chosen.candidate,
              provider: first.chosen.provider,
            },
            reason: null,
          },
        ],
        override: cliOverrideInput("codex-lower"),
      }),
    /override: applies only to the initial selection step/,
  );
  assert.throws(
    () =>
      selectCandidate({
        config: policyConfig(),
        workload: policyWorkload(),
        key: policyKey(),
        override: { ...cliOverrideInput("codex-lower"), selector: { task: "task-9999", role: "implementer" } },
      }),
    RoutingPolicyError,
  );
});

test("recorded override evidence is immutable and cannot be forged", () => {
  const selected = selectCandidate({
    config: policyConfig(),
    workload: policyWorkload(),
    key: policyKey(),
    override: cliOverrideInput("codex-lower"),
  });
  const record = decisionRecordFromSelection(selected, { recorded_at: NOW });

  const gates = structuredClone(record);
  gates.override.hard_gates_passed = false;
  assert.throws(
    () => validateDecisionRecord(gates),
    /must confirm every hard safety gate passed/,
  );

  const rationale = structuredClone(record);
  rationale.override.displaced_rationale = "operator felt like it";
  assert.throws(
    () => validateDecisionRecord(rationale),
    /must be the deterministic displaced rationale/,
  );

  const winner = structuredClone(record);
  winner.override.policy_winner = structuredClone(winner.chosen);
  winner.override.displaced_rationale = "override matches the normal policy winner";
  assert.throws(
    () => validateDecisionRecord(winner),
    /must be the stable candidate-id winner for the greatest provider deficit/,
  );

  const mismatch = structuredClone(record);
  mismatch.override.candidate = "claude-lower";
  mismatch.override.displaced_rationale = "override matches the normal policy winner";
  assert.throws(
    () => validateDecisionRecord(mismatch),
    /override.candidate: must match the chosen candidate/,
  );

  const laterStep = structuredClone(record);
  laterStep.step = 1;
  laterStep.parent_step = 0;
  laterStep.reason = normalizeFailureReason("timeout", "");
  assert.throws(
    () => validateDecisionRecord(laterStep),
    /must be attached to the initial selection step/,
  );

  const configDisplacement = structuredClone(record);
  configDisplacement.override.source = "config";
  configDisplacement.override.displaced_config_candidate = "claude-lower";
  assert.throws(
    () => validateDecisionRecord(configDisplacement),
    /only recorded when a CLI override displaces a configured override/,
  );

  const budgets = structuredClone(record);
  budgets.override.displaced_budgets = ["cost_budget_exceeded"];
  assert.throws(
    () => validateDecisionRecord(budgets),
    /must equal the chosen candidate's displaceable gate evidence/,
  );
});

// --- precedence resolution ----------------------------------------------------

test("override precedence is exact before wildcard and CLI before config at equal specificity", () => {
  const config = {
    overrides: [
      {
        selector: { task: "task-9001", role: "implementer" },
        candidate: "cfg-exact",
        allow_fallback: true,
      },
      {
        selector: { task: "*", role: "implementer" },
        candidate: "cfg-wild",
        allow_fallback: false,
      },
    ],
  };
  const cliRules = normalizeRouteOverrides([
    "task-9001:implementer=cli-exact",
    "*:implementer=cli-wild",
  ]);

  assert.deepEqual(
    resolveRouteOverride({ cliOverrides: cliRules, config, task: "task-9001", role: "implementer" }),
    {
      candidate: "cli-exact",
      source: "cli",
      selector: { task: "task-9001", role: "implementer" },
      allow_fallback: false,
      displaced_config_candidate: "cfg-exact",
    },
  );
  // A configured exact selector still beats a CLI wildcard.
  assert.deepEqual(
    resolveRouteOverride({
      cliOverrides: normalizeRouteOverrides(["*:implementer=cli-wild"]),
      config,
      task: "task-9001",
      role: "implementer",
    }),
    {
      candidate: "cfg-exact",
      source: "config",
      selector: { task: "task-9001", role: "implementer" },
      allow_fallback: true,
      displaced_config_candidate: null,
    },
  );
  assert.deepEqual(
    resolveRouteOverride({ cliOverrides: cliRules, config, task: "task-9002", role: "implementer" }),
    {
      candidate: "cli-wild",
      source: "cli",
      selector: { task: "*", role: "implementer" },
      allow_fallback: false,
      displaced_config_candidate: "cfg-wild",
    },
  );
  assert.deepEqual(
    resolveRouteOverride({ cliOverrides: [], config, task: "task-9002", role: "implementer" }),
    {
      candidate: "cfg-wild",
      source: "config",
      selector: { task: "*", role: "implementer" },
      allow_fallback: false,
      displaced_config_candidate: null,
    },
  );
  assert.equal(
    resolveRouteOverride({ cliOverrides: cliRules, config, task: "task-9001", role: "reviewer" }),
    null,
  );
  assert.equal(
    resolveRouteOverride({ cliOverrides: [], config: { overrides: [] }, task: "task-9001", role: "implementer" }),
    null,
  );
});

// --- routed dispatch through the engine ---------------------------------------

const TASK_ID = "task-9700";

function candidate(id, provider, roles, mode, tier = "high") {
  return {
    id,
    provider,
    model: `${provider}-${tier}-model`,
    tier,
    roles,
    command: [process.execPath, fixture, mode],
    enabled: true,
    context_limit: 100_000,
    capabilities: [],
    cost_class: "standard",
    latency_class: "standard",
  };
}

function dispatchConfig(candidates, extra = {}) {
  const providers = [...new Set(candidates.map(({ provider }) => provider))];
  return {
    schema: "aios.routing/v1",
    tiers: [{ id: "high", rank: 1 }],
    capabilities: [],
    cost_classes: ["standard"],
    latency_classes: ["standard"],
    candidates,
    policy: {
      high_tier: "high",
      distribution_window: 10,
      provider_targets: providers.map((provider) => ({ provider, weight: 1 })),
      limits: { fallbacks_per_action: 3, escalations_per_task: 2 },
      default_budgets: { cost: "standard", latency: "standard" },
    },
    hints: [],
    overrides: extra.overrides ?? [],
  };
}

function taskDocument(id) {
  const metadata = {
    schema: "aios.task/v1",
    id,
    project: "override-test",
    title: "Route one overridden action",
    state: "implement",
    retry: { count: 0, limit: 2 },
    approval: "not_required",
    last_review: null,
  };
  const body = [
    "",
    "# Route one overridden action",
    "",
    "## Objective",
    "",
    "Exercise operator-overridden routed dispatch.",
    "",
    "## Acceptance Criteria",
    "",
    "- The accepted Result is projected once.",
    "",
    "## Attempts",
    "",
    "_None yet._",
    "",
  ].join("\n");
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

async function repository(t, routingConfig, taskId = TASK_ID) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-route-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", `${taskId}.md`),
    taskDocument(taskId),
    "utf8",
  );
  const configPath = path.join(root, "routing.json");
  await writeFile(configPath, `${JSON.stringify(routingConfig, null, 2)}\n`, "utf8");
  return { root, configPath };
}

async function readLedger(root) {
  return JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
}

test("a CLI override pins the Implementer over exact/wildcard and configured rules", async (t) => {
  const routingConfig = dispatchConfig(
    [
      candidate("a-implementer", "alpha", ["implementer"], "auto-loop"),
      candidate("b-implementer", "beta", ["implementer"], "auto-loop"),
      candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
      candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
    ],
    {
      overrides: [
        {
          selector: { task: TASK_ID, role: "implementer" },
          candidate: "a-implementer",
          allow_fallback: true,
        },
      ],
    },
  );
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, {
    cwd: root,
    routeOverrides: normalizeRouteOverrides([
      "*:implementer=a-implementer",
      `${TASK_ID}:implementer=b-implementer`,
    ]),
  });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = await readLedger(root);
  const implementer = ledger.decisions.find((entry) => entry.key.role === "implementer");
  assert.equal(implementer.chosen.candidate, "b-implementer");
  assert.deepEqual(implementer.override, {
    candidate: "b-implementer",
    source: "cli",
    selector: { task: TASK_ID, role: "implementer" },
    allow_fallback: false,
    policy_winner: {
      candidate: "a-implementer",
      provider: "alpha",
      model: "alpha-high-model",
      tier: "high",
    },
    displaced_budgets: [],
    displaced_rationale: "override displaced normal policy winner a-implementer",
    displaced_config_candidate: "a-implementer",
    hard_gates_passed: true,
  });
  const reviewer = ledger.decisions.find((entry) => entry.key.role === "reviewer");
  assert.equal(reviewer.override, null);
  const summary = assignments.routingSummary();
  assert.equal(summary.role, "reviewer");
  assert.equal(summary.override, null);
});

test("a configured override with fallback allowed follows the bounded route and keeps its audit row", async (t) => {
  const routingConfig = dispatchConfig(
    [
      candidate("a-implementer", "alpha", ["implementer"], "fresh-loop"),
      candidate("b-implementer", "beta", ["implementer"], "nonzero"),
      candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
    ],
    {
      overrides: [
        {
          selector: { task: "*", role: "implementer" },
          candidate: "b-implementer",
          allow_fallback: true,
        },
      ],
    },
  );
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = await readLedger(root);
  const implementer = ledger.decisions.filter((entry) => entry.key.role === "implementer");
  assert.deepEqual(
    implementer.map((entry) => [entry.chosen.candidate, entry.status]),
    [
      ["b-implementer", "failed"],
      ["a-implementer", "completed"],
    ],
  );
  // The fallback never cancels the recorded fact that step 0 was overridden.
  assert.equal(implementer[0].override.source, "config");
  assert.equal(implementer[0].override.allow_fallback, true);
  assert.equal(implementer[0].override.policy_winner.candidate, "a-implementer");
  assert.deepEqual(
    implementer[0].events.map(({ kind }) => kind),
    ["launch", "failure", "fallback"],
  );
  assert.equal(implementer[1].override, null);
  assert.equal(implementer[1].reason.code, "provider_failure");
  const summary = assignments.routingSummary();
  assert.equal(summary.role, "reviewer");
});

test("a fallback-denying override stops with the existing halted outcome and names the denial", async (t) => {
  const routingConfig = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "nonzero"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, {
    cwd: root,
    routeOverrides: normalizeRouteOverrides([`${TASK_ID}:implementer=a-implementer`]),
  });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(
    outcome.reason,
    /Route override pinned candidate a-implementer and denies fallback after provider_failure/,
  );
  const ledger = await readLedger(root);
  assert.equal(ledger.decisions.length, 1);
  assert.equal(ledger.decisions[0].override.allow_fallback, false);
  assert.deepEqual(
    ledger.decisions[0].events.map(({ kind }) => kind),
    ["launch", "failure", "exhausted"],
  );
  assert.match(
    ledger.decisions[0].events[2].reason.diagnostic,
    /route override a-implementer denies fallback after provider_failure/,
  );
  const summary = assignments.routingSummary();
  assert.deepEqual(summary.override, {
    source: "cli",
    candidate: "a-implementer",
    allow_fallback: false,
  });
});

test("capacity under a fallback-denying override preserves the waiting outcome", async (t) => {
  const routingConfig = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "deferred"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, {
    cwd: root,
    routeOverrides: normalizeRouteOverrides(["*:implementer=a-implementer"]),
  });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  // Without the override this configuration falls back to b-implementer.
  assert.equal(outcome.kind, "waiting");
  const ledger = await readLedger(root);
  assert.equal(ledger.decisions.length, 1);
  assert.equal(ledger.decisions[0].chosen.candidate, "a-implementer");
  assert.deepEqual(
    ledger.decisions[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause"],
  );
});

test("re-resolving reuses the recorded overridden decision and a changed override conflicts", async (t) => {
  const routingConfig = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "auto-loop"),
    candidate("b-implementer", "beta", ["implementer"], "auto-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const task = await new TaskStore(root).loadTask(TASK_ID);
  const context = Object.freeze({
    task,
    role: "implementer",
    attempt: 1,
    reviewGeneration: null,
    reviews: Object.freeze([]),
    runOptions: Object.freeze({}),
    routingPolicyRevision: null,
  });
  const overridden = () =>
    new RoutedAssignmentResolver(configPath, {
      cwd: root,
      routeOverrides: normalizeRouteOverrides(["*:implementer=b-implementer"]),
    });

  await overridden().resolve("implementer", context);
  let ledger = await readLedger(root);
  assert.equal(ledger.decisions.length, 1);
  assert.equal(ledger.decisions[0].status, "selected");
  assert.equal(ledger.decisions[0].chosen.candidate, "b-implementer");

  // The identical override input reuses the persisted decision.
  await overridden().resolve("implementer", context);
  ledger = await readLedger(root);
  assert.equal(ledger.decisions.length, 1);

  await assert.rejects(
    new RoutedAssignmentResolver(configPath, {
      cwd: root,
      routeOverrides: normalizeRouteOverrides(["*:implementer=a-implementer"]),
    }).resolve("implementer", context),
    /recorded with a different route-override input.*new attempt/,
  );
  await assert.rejects(
    new RoutedAssignmentResolver(configPath, { cwd: root }).resolve("implementer", context),
    /recorded with a different route-override input/,
  );
  ledger = await readLedger(root);
  assert.equal(ledger.decisions.length, 1);
  assert.equal(ledger.decisions[0].chosen.candidate, "b-implementer");
});

// --- CLI surface ---------------------------------------------------------------

async function cliRepository(t, executionConfig, taskId = "task-9001") {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", `${taskId}.md`),
    taskDocument(taskId),
    "utf8",
  );
  const configPath = path.join(root, "execution.json");
  await writeFile(configPath, `${JSON.stringify(executionConfig, null, 2)}\n`, "utf8");
  return { root, configPath };
}

function runCli(root, args) {
  return executeFile(process.execPath, [cli, ...args], { cwd: root, windowsHide: true });
}

test("invalid route overrides exit 64 before any Worker launch or Task mutation", async (t) => {
  const routingConfig = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "auto-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await cliRepository(t, routingConfig);
  const taskPath = path.join(root, ".aios", "tasks", "task-9001.md");
  const before = await readFile(taskPath, "utf8");
  const cases = [
    ["task-1:implementer=a-implementer", /invalid Task selector task-1/],
    ["*:approver=a-implementer", /cannot target approver/],
    ["*:builder=a-implementer", /unknown Role builder/],
    ["*:implementer", /must be shaped/],
    ["*:implementer=Bad", /invalid candidate id Bad/],
    ["*:implementer=missing-candidate", /not in the routing catalog/],
    ["*:implementer=c-reviewer", /ineligible for Role implementer/],
  ];
  for (const [value, expected] of cases) {
    await assert.rejects(
      runCli(root, [
        "run",
        "task-9001",
        "--root",
        root,
        "--assignments",
        configPath,
        "--route-override",
        value,
      ]),
      (error) => error.code === 64 && expected.test(error.stderr),
      `expected exit 64 for override ${value}`,
    );
  }
  await assert.rejects(
    runCli(root, [
      "run",
      "task-9001",
      "--root",
      root,
      "--assignments",
      configPath,
      "--route-override",
      "*:implementer=a-implementer",
      "--route-override",
      "*:implementer=a-implementer",
    ]),
    (error) => error.code === 64 && /duplicate or conflicting rules/.test(error.stderr),
  );
  await assert.rejects(
    runCli(root, ["progress", "plans/none", "--root", root, "--route-override", "bad"]),
    (error) => error.code === 64 && /must be shaped/.test(error.stderr),
  );
  await assert.rejects(
    runCli(root, ["run", "task-9001", "--root", root, "--route-override"]),
    (error) => error.code === 64 && /Missing value for --route-override/.test(error.stderr),
  );

  assert.equal(await readFile(taskPath, "utf8"), before);
  assert.equal(existsSync(routingDecisionsPath(root)), false);
  assert.equal(existsSync(path.join(root, ".aios", "runtime", "sessions.json")), false);
});

test("a route override with a legacy Assignment config exits 64 without dispatch", async (t) => {
  const legacy = {
    schema: "aios.assignments/v1",
    assignments: {
      implementer: [process.execPath, fixture, "auto-loop"],
      reviewer: [process.execPath, fixture, "auto-loop"],
    },
  };
  const { root, configPath } = await cliRepository(t, legacy);
  await assert.rejects(
    runCli(root, [
      "run",
      "task-9001",
      "--root",
      root,
      "--assignments",
      configPath,
      "--route-override",
      "*:implementer=a-implementer",
    ]),
    (error) =>
      error.code === 64 &&
      /requires an aios\.routing\/v1 execution configuration/.test(error.stderr),
  );
  assert.equal(existsSync(path.join(root, ".aios", "runtime", "sessions.json")), false);
  const task = await new TaskStore(root).loadTask("task-9001");
  assert.equal(task.metadata.state, "implement");
});

test("run reports the routing summary with and without an override; legacy stdout is unchanged", async (t) => {
  const routingConfig = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "auto-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
    candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
  ]);

  const overridden = await cliRepository(t, routingConfig);
  const withOverride = await runCli(overridden.root, [
    "run",
    "task-9001",
    "--root",
    overridden.root,
    "--assignments",
    overridden.configPath,
    "--route-override",
    "*:reviewer=c-reviewer",
  ]);
  const overriddenReport = JSON.parse(withOverride.stdout);
  assert.equal(overriddenReport.kind, "done");
  assert.deepEqual(overriddenReport.routing, {
    task: "task-9001",
    role: "reviewer",
    attempt: 1,
    step: 0,
    candidate: "c-reviewer",
    provider: "gamma",
    model: "gamma-high-model",
    tier: "high",
    override: { source: "cli", candidate: "c-reviewer", allow_fallback: false },
    reason: null,
  });
  const overriddenLedger = await readLedger(overridden.root);
  assert.equal(
    overriddenLedger.decisions.find((entry) => entry.key.role === "reviewer").override
      .policy_winner.candidate,
    "d-reviewer",
  );

  const plain = await cliRepository(t, routingConfig);
  const withoutOverride = await runCli(plain.root, [
    "run",
    "task-9001",
    "--root",
    plain.root,
    "--assignments",
    plain.configPath,
  ]);
  const plainReport = JSON.parse(withoutOverride.stdout);
  assert.equal(plainReport.kind, "done");
  assert.equal(plainReport.routing.role, "reviewer");
  assert.equal(plainReport.routing.override, null);
  assert.equal(plainReport.routing.step, 0);

  const legacy = await cliRepository(t, {
    schema: "aios.assignments/v1",
    assignments: {
      implementer: [process.execPath, fixture, "auto-loop"],
      reviewer: [process.execPath, fixture, "auto-loop"],
    },
  });
  const legacyRun = await runCli(legacy.root, [
    "run",
    "task-9001",
    "--root",
    legacy.root,
    "--assignments",
    legacy.configPath,
  ]);
  assert.equal(
    legacyRun.stdout,
    '{"kind":"done","task":"task-9001","state":"done","reason":null}\n',
  );
});

async function progressPlan(root, taskIds) {
  const dir = path.join(root, "plans", "override-plan");
  await mkdir(dir, { recursive: true });
  const metadata = {
    schema: "aios.plan/v1",
    id: "override-plan",
    project: "override-test",
    profile: "software-feature",
    profile_reason: "Testing routing overrides in progression.",
  };
  const list = taskIds
    .map((entry, index) => `${index + 1}. ${entry} advances step ${index + 1}.`)
    .join("\n");
  const body = [
    "",
    "# Override plan",
    "",
    "## Brief",
    "",
    "Demo brief.",
    "",
    "## Profile Application",
    "",
    "Demo application.",
    "",
    "## Assumptions and Risks",
    "",
    "None.",
    "",
    "## Decomposition Rationale",
    "",
    "Demo rationale.",
    "",
    "## Execution Order",
    "",
    list,
    "",
  ].join("\n");
  await writeFile(
    path.join(dir, "PLAN.md"),
    `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`,
    "utf8",
  );
  return dir;
}

test("progress reports the routing summary for the stopped Task or null on completion", async (t) => {
  const halting = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "nonzero"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const haltingRepo = await cliRepository(t, halting, "task-9001");
  await progressPlan(haltingRepo.root, ["task-9001"]);
  await assert.rejects(
    runCli(haltingRepo.root, [
      "progress",
      "plans/override-plan",
      "--root",
      haltingRepo.root,
      "--assignments",
      haltingRepo.configPath,
    ]),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 7 &&
        report.stop_reason === "worker_failure" &&
        report.routing.task === "task-9001" &&
        report.routing.candidate === "a-implementer" &&
        report.routing.override === null
      );
    },
  );

  const completing = dispatchConfig([
    candidate("a-implementer", "alpha", ["implementer"], "auto-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const completingRepo = await cliRepository(t, completing, "task-9001");
  await progressPlan(completingRepo.root, ["task-9001"]);
  const { stdout } = await runCli(completingRepo.root, [
    "progress",
    "plans/override-plan",
    "--root",
    completingRepo.root,
    "--assignments",
    completingRepo.configPath,
    "--route-override",
    "task-9001:implementer=a-implementer",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.stop_reason, "plan_complete");
  assert.equal(report.routing, null);
  const ledger = await readLedger(completingRepo.root);
  assert.equal(
    ledger.decisions.find((entry) => entry.key.role === "implementer").override.source,
    "cli",
  );

  const legacyRepo = await cliRepository(t, {
    schema: "aios.assignments/v1",
    assignments: {
      implementer: [process.execPath, fixture, "auto-loop"],
      reviewer: [process.execPath, fixture, "auto-loop"],
    },
  });
  await progressPlan(legacyRepo.root, ["task-9001"]);
  const legacyRun = await runCli(legacyRepo.root, [
    "progress",
    "plans/override-plan",
    "--root",
    legacyRepo.root,
    "--assignments",
    legacyRepo.configPath,
  ]);
  assert.equal(
    legacyRun.stdout,
    JSON.stringify({
      plan: "override-plan",
      completed: ["task-9001"],
      complete: true,
      task: null,
      stop_reason: "plan_complete",
      action: "No action needed: every Task in the plan is done.",
    }) + "\n",
  );
});

test("help documents the override flag and shell quoting", async () => {
  const { stdout } = await executeFile(process.execPath, [cli, "--help"], {
    windowsHide: true,
  });
  assert.match(stdout, /--route-override <task-selector>:<role>=<candidate-id>/);
  assert.match(stdout, /PowerShell/);
  assert.match(stdout, /POSIX/);
  assert.match(stdout, /implementer or reviewer/);
  assert.match(stdout, /approver stays[\s\S]*outside model routing/);
});
