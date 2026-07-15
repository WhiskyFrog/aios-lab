import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import {
  decisionRecordFromSelection,
  RoutingDecisionLedger,
  routingDecisionsPath,
} from "../src/routing-ledger.js";
import { selectCandidate } from "../src/routing-policy.js";
import { FileAssignmentResolver } from "../src/workers.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");
const routingWorker = path.join(projectRoot, "fixtures", "routing-worker.js");
const legacyWorker = path.join(projectRoot, "fixtures", "command-worker.js");

// --- fixture builders --------------------------------------------------------

function candidate(
  id,
  provider,
  model,
  tier,
  roles,
  mode,
  { cost = "standard", latency = "standard", extra = [] } = {},
) {
  return {
    id,
    provider,
    model,
    tier,
    roles,
    command: [process.execPath, routingWorker, provider, model, mode, ...extra],
    enabled: true,
    context_limit: 200_000,
    capabilities: [],
    cost_class: cost,
    latency_class: latency,
  };
}

function routingConfig({
  candidates,
  tiers = [
    { id: "lower", rank: 1 },
    { id: "high", rank: 2 },
  ],
  highTier = "high",
  weights = { claude: 1, codex: 1 },
  window = 12,
  limits = { fallbacks_per_action: 3, escalations_per_task: 2 },
  hints = [],
  overrides = [],
} = {}) {
  const providers = [...new Set(candidates.map(({ provider }) => provider))].sort();
  return {
    schema: "aios.routing/v1",
    tiers,
    capabilities: [],
    cost_classes: ["economy", "standard"],
    latency_classes: ["standard"],
    candidates,
    policy: {
      high_tier: highTier,
      distribution_window: window,
      provider_targets: providers.map((provider) => ({
        provider,
        weight: weights[provider],
      })),
      limits,
      default_budgets: { cost: "standard", latency: "standard" },
    },
    hints,
    overrides,
  };
}

function implementationHint(taskId, { risk = "low", plan = null } = {}) {
  return {
    selector: { task: plan === null ? taskId : null, plan },
    work_kind: "implementation",
    complexity: "low",
    risk,
    required_capabilities: [],
    verification: "objective",
    cost_budget: "standard",
    latency_budget: "standard",
  };
}

function planningHint(taskId) {
  return {
    selector: { task: taskId, plan: null },
    work_kind: "planning",
    complexity: "high",
    risk: "high",
    required_capabilities: [],
    verification: "subjective",
    cost_budget: "standard",
    latency_budget: "standard",
  };
}

function taskDocument(
  id,
  { project = "routing-e2e", retryCount = 0, seedAttempt = null, lastReview = null } = {},
) {
  const metadata = {
    schema: "aios.task/v1",
    id,
    project,
    title: `Deliver ${id}`,
    state: "implement",
    retry: { count: retryCount, limit: 2 },
    approval: "not_required",
    last_review: lastReview,
  };
  const attempts =
    seedAttempt === null
      ? "_None yet._"
      : `<!-- aios:attempt-frame v1 number=1 summary=${seedAttempt.summary.length} verification=${seedAttempt.verification.length} -->
### Attempt 1

#### Summary

${seedAttempt.summary}

#### Verification

${seedAttempt.verification}
<!-- /aios:attempt-frame v1 number=1 -->`;
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n
# Deliver ${id}

## Objective

Deliver one deterministic routed outcome.

## Acceptance Criteria

- The fake provider Worker completes the Task.

## Attempts

${attempts}
`;
}

function reviewDocument(id, taskId, { project = "routing-e2e" } = {}) {
  const metadata = {
    schema: "aios.review/v1",
    id,
    project,
    task: taskId,
    attempt: 1,
    verdict: "changes_requested",
  };
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n
# Review

## Findings

Correct the repeated evidence.
`;
}

async function repository(t, config, taskIds, taskOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  for (const id of taskIds) {
    await writeFile(
      path.join(root, ".aios", "tasks", `${id}.md`),
      taskDocument(id, taskOptions[id] ?? {}),
      "utf8",
    );
  }
  const configPath = path.join(root, "routing.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { root, configPath };
}

async function ledgerDecisions(root) {
  return JSON.parse(await readFile(routingDecisionsPath(root), "utf8")).decisions;
}

function engineFor(root, configPath, { timeoutMs = 300_000, routeOverrides = [] } = {}) {
  const assignments = new FileAssignmentResolver(configPath, {
    cwd: root,
    timeoutMs,
    routeOverrides,
  });
  return { assignments, engine: new LoopEngine({ root, assignments }) };
}

function reviewerPool(mode = "complete") {
  return [
    candidate("claude-high-reviewer", "claude", "fake-claude-high", "high", ["reviewer"], mode),
    candidate("codex-high-reviewer", "codex", "fake-codex-high", "high", ["reviewer"], mode),
  ];
}

// --- planning stays high tier ------------------------------------------------

test("a planning Task selects only a high-tier candidate although cost and deficit favor the lower one", async (t) => {
  const config = routingConfig({
    weights: { claude: 3, codex: 1 },
    candidates: [
      candidate(
        "claude-lower-implementer",
        "claude",
        "fake-claude-lower",
        "lower",
        ["implementer"],
        "complete",
        { cost: "economy" },
      ),
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
    hints: [planningHint("task-9902")],
  });
  const { root, configPath } = await repository(t, config, ["task-9901", "task-9902"]);
  const { engine } = engineFor(root, configPath);

  // A first general Task seeds the window with one claude and one codex row,
  // so the 3:1 targets leave claude — the lower candidate's provider — with
  // the greatest deficit when the planning Task is routed.
  assert.equal((await engine.run("task-9901")).kind, "done");
  assert.equal((await engine.run("task-9902")).kind, "done");

  const planning = (await ledgerDecisions(root)).find(
    (entry) => entry.key.task === "task-9902" && entry.key.role === "implementer",
  );
  assert.equal(planning.workload.work_kind, "planning");
  assert.equal(planning.workload.minimum_tier, "high");
  assert.equal(planning.chosen.tier, "high");
  assert.equal(planning.chosen.candidate, "claude-high-implementer");
  const lower = planning.considered.find(
    (entry) => entry.candidate === "claude-lower-implementer",
  );
  assert.equal(lower.eligible, false);
  assert.deepEqual(lower.reasons, ["tier_below_minimum"]);
  const deficits = Object.fromEntries(
    planning.distribution.deficits.map(({ provider, numerator, denominator }) => [
      provider,
      Number(numerator) / Number(denominator),
    ]),
  );
  assert.ok(deficits.claude > deficits.codex);
});

// --- bounded implementation and cross-provider review -------------------------

test("a bounded low-risk implementation uses a lower-tier Implementer and a cross-provider Reviewer", async (t) => {
  const config = routingConfig({
    candidates: [
      candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("codex-lower-implementer", "codex", "fake-codex-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
    hints: [implementationHint("task-9903"), implementationHint("task-9904", { risk: "high" })],
  });
  const { root, configPath } = await repository(t, config, ["task-9903", "task-9904"]);
  const { engine } = engineFor(root, configPath);

  assert.equal((await engine.run("task-9903")).kind, "done");
  assert.equal((await engine.run("task-9904")).kind, "done");

  const decisions = await ledgerDecisions(root);
  const tierRank = new Map(config.tiers.map(({ id, rank }) => [id, rank]));
  const bounded = decisions.filter((entry) => entry.key.task === "task-9903");
  const [implementer, reviewer] = ["implementer", "reviewer"].map((role) =>
    bounded.find((entry) => entry.key.role === role),
  );
  assert.equal(implementer.chosen.tier, "lower");
  assert.equal(implementer.workload.lower_tier.eligible, true);
  assert.notEqual(reviewer.chosen.provider, implementer.chosen.provider);
  assert.ok(tierRank.get(reviewer.chosen.tier) >= tierRank.get(implementer.chosen.tier));

  // The companion fixture flips exactly one workload signal to high risk.
  const risky = decisions.find(
    (entry) => entry.key.task === "task-9904" && entry.key.role === "implementer",
  );
  assert.equal(risky.workload.risk, "high");
  assert.deepEqual(risky.workload.lower_tier.rejection_reasons, ["risk_not_low"]);
  assert.equal(risky.chosen.tier, "high");
});

// --- weighted distribution ----------------------------------------------------

function distributionWorkload(taskId) {
  return {
    task_id: taskId,
    role: "implementer",
    work_kind: "unknown",
    parent_plan: null,
    complexity: "low",
    risk: "unknown",
    context_size: { bytes: 2_000, estimated_tokens: 500, band: "small" },
    required_capabilities: [],
    verification_burden: "unknown",
    budgets: { cost: "standard", latency: "standard" },
    approval: "not_required",
    retry: { count: 0, limit: 2 },
    history: {
      reviews_total: 0,
      changes_requested: 0,
      sessions_failed: 0,
      capacity_deferred: 0,
    },
    uncertainty_flags: [
      "parent_plan_missing",
      "required_capabilities_unknown",
      "risk_unknown",
      "verification_unknown",
      "work_kind_unknown",
    ],
    minimum_tier: "high",
    lower_tier: {
      eligible: false,
      rejection_reasons: [
        "work_not_bounded_implementation",
        "risk_not_low",
        "capabilities_not_explicit",
        "verification_not_objective",
        "safety_evidence_uncertain",
      ],
    },
    sources: {
      task_id: "task.metadata.id",
      role: "engine.active_role",
      work_kind: "default",
      parent_plan: "plan_scan",
      complexity: "task.structure",
      risk: "default",
      context_size: "task.raw_utf8",
      required_capabilities: "default_unknown",
      verification_burden: "default_unknown",
      budgets: "routing.policy.default_budgets",
      approval: "task.metadata.approval",
      retry: "task.metadata.retry",
      history: "provided_review_session_history",
      minimum_tier: "routing.policy.high_tier",
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

async function runDistributionSequence(t, config, count) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new RoutingDecisionLedger(path.join(root, "routing-decisions.json"));
  let snapshot = await ledger.load();
  const sequence = [];
  const base = Date.parse("2026-07-15T05:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const key = {
      task: `task-${String(9810 + index)}`,
      role: "implementer",
      attempt: 1,
      policy_revision: "policy-e2e",
    };
    const selection = selectCandidate({
      config,
      workload: distributionWorkload(key.task),
      key,
      history: snapshot.decisions.map((record) => ({
        key: { ...record.key },
        step: record.step,
        chosen: {
          candidate: record.chosen.candidate,
          provider: record.chosen.provider,
        },
        reason: record.reason === null ? null : { code: record.reason.code },
      })),
    });
    snapshot = await ledger.record(
      snapshot,
      decisionRecordFromSelection(selection, {
        recorded_at: new Date(base + index * 1_000).toISOString(),
      }),
    );
    sequence.push(selection.chosen.candidate);
  }
  return { ledger, sequence };
}

test("independent decision keys converge to the configured 3:1 Claude/Codex weights with stable ties", async (t) => {
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    weights: { claude: 3, codex: 1 },
    window: 16,
    candidates: [
      candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], "complete"),
      candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
  });

  const first = await runDistributionSequence(t, config, 16);
  const second = await runDistributionSequence(t, config, 16);

  const claude = "claude-standard-implementer";
  const codex = "codex-standard-implementer";
  // Ties at indexes 0, 4, 8, and 12 (both deficits exactly zero) always fall
  // to the first provider in sorted order, so the sequence is fully stable.
  assert.deepEqual(first.sequence, [
    claude, codex, claude, claude,
    claude, codex, claude, claude,
    claude, codex, claude, claude,
    claude, codex, claude, claude,
  ]);
  assert.deepEqual(second.sequence, first.sequence);
  assert.equal(first.sequence.filter((entry) => entry === claude).length, 12);
  assert.equal(first.sequence.filter((entry) => entry === codex).length, 4);

  // Re-resolving the oldest key after the window filled with newer decisions
  // proves the recorded candidate does not drift.
  const resolved = await first.ledger.resolveKey({
    task: "task-9810",
    role: "implementer",
    attempt: 1,
    policy_revision: "policy-e2e",
  });
  assert.equal(resolved.active.chosen.candidate, first.sequence[0]);
  assert.equal(resolved.active.step, 0);
});

// --- recovery ------------------------------------------------------------------

test("Claude capacity falls back to the equivalent Codex candidate before any promotion", async (t) => {
  const config = routingConfig({
    tiers: [
      { id: "high", rank: 1 },
      { id: "premium", rank: 2 },
    ],
    highTier: "high",
    candidates: [
      candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], "capacity-always"),
      candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
      candidate("claude-premium-implementer", "claude", "fake-claude-premium", "premium", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9905"]);
  const { engine } = engineFor(root, configPath);

  const outcome = await engine.run("task-9905");

  assert.equal(outcome.kind, "done");
  const implementer = (await ledgerDecisions(root)).filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.deepEqual(
    implementer.map((entry) => [entry.chosen.candidate, entry.chosen.tier, entry.reason?.code ?? null]),
    [
      ["claude-standard-implementer", "high", null],
      ["codex-standard-implementer", "high", "capacity"],
    ],
  );
  assert.deepEqual(
    implementer[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause", "failure", "fallback"],
  );
  assert.equal(
    implementer[0].events[1].session_id,
    "claude-fake-claude-standard-task-9905-implementer",
  );
  // The premium candidate was never promoted, and the codex Worker completed
  // only because no claude-bound continuation crossed providers (the fixture
  // exits nonzero when a foreign continuation arrives).
  assert.ok(!implementer.some((entry) => entry.chosen.candidate === "claude-premium-implementer"));
});

for (const [label, mode, reason, timeoutMs] of [
  ["provider failure", "provider-failure", "provider_failure", 300_000],
  ["timeout", "timeout", "timeout", 500],
]) {
  test(`Claude ${label} falls back to the equivalent Codex candidate`, async (t) => {
    const config = routingConfig({
      tiers: [{ id: "high", rank: 1 }],
      candidates: [
        candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], mode),
        candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
        ...reviewerPool(),
      ],
    });
    const { root, configPath } = await repository(t, config, ["task-9905"]);
    const { engine } = engineFor(root, configPath, { timeoutMs });

    assert.equal((await engine.run("task-9905")).kind, "done");
    const implementer = (await ledgerDecisions(root)).filter(
      (entry) => entry.key.role === "implementer",
    );
    assert.equal(implementer[1].chosen.provider, "codex");
    assert.equal(implementer[1].chosen.tier, implementer[0].chosen.tier);
    assert.equal(implementer[1].reason.code, reason);
  });
}

for (const [mode, reason] of [
  ["verification-failure", "verification_failed"],
  ["context-failure", "context_insufficient"],
]) {
  test(`a typed ${reason} Result promotes to a strictly stronger unused candidate`, async (t) => {
    const config = routingConfig({
      candidates: [
        candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], mode, {
          cost: "economy",
        }),
        candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
        candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
        ...reviewerPool(),
      ],
      hints: [implementationHint("task-9906")],
    });
    const { root, configPath } = await repository(t, config, ["task-9906"]);
    const { engine } = engineFor(root, configPath);

    assert.equal((await engine.run("task-9906")).kind, "done");
    const implementer = (await ledgerDecisions(root)).filter(
      (entry) => entry.key.role === "implementer",
    );
    assert.deepEqual(
      implementer.map((entry) => [entry.chosen.tier, entry.reason?.code ?? null]),
      [
        ["lower", null],
        ["high", reason],
      ],
    );
    assert.notEqual(implementer[1].chosen.candidate, implementer[0].chosen.candidate);
    assert.deepEqual(
      implementer[0].events.map(({ kind }) => kind),
      ["launch", "failure", "escalation"],
    );
  });
}

test("a rejected Review promotes the next Implementer attempt without resetting the retry count", async (t) => {
  const config = routingConfig({
    candidates: [
      candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      ...reviewerPool("review-cycle"),
    ],
    hints: [implementationHint("task-9908")],
  });
  const { root, configPath } = await repository(t, config, ["task-9908"]);
  const { engine } = engineFor(root, configPath);

  assert.equal((await engine.run("task-9908")).kind, "done");
  const implementer = (await ledgerDecisions(root)).filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.deepEqual(
    implementer.map((entry) => [entry.key.attempt, entry.chosen.tier]),
    [
      [1, "lower"],
      [2, "high"],
    ],
  );
  const store = new TaskStore(root);
  const task = await store.loadTask("task-9908");
  assert.equal(task.metadata.retry.count, 1);
  assert.equal((await store.listReviews()).length, 2);
});

test("duplicate Attempt evidence cannot loop and stops in the documented halt", async (t) => {
  const seedAttempt = {
    summary: "Repeated fixture evidence.",
    verification: "Repeated fixture verification.",
  };
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    candidates: [
      candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], "repeat-evidence"),
      ...reviewerPool(),
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9909"], {
    "task-9909": { retryCount: 1, seedAttempt, lastReview: "review-9909" },
  });
  await writeFile(
    path.join(root, ".aios", "reviews", "review-9909.md"),
    reviewDocument("review-9909", "task-9909"),
    "utf8",
  );
  const { engine } = engineFor(root, configPath);

  const outcome = await engine.run("task-9909");

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /Bounded routing exhausted after repeated_evidence/);
  const decisions = await ledgerDecisions(root);
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    decisions[0].events.map(({ kind, reason }) => [kind, reason?.code ?? null]),
    [
      ["launch", null],
      ["failure", "repeated_evidence"],
      ["exhausted", "routing_exhausted"],
    ],
  );
  const task = await new TaskStore(root).loadTask("task-9909");
  assert.equal(task.metadata.retry.count, 1);
  assert.equal([...task.body.matchAll(/^### Attempt /gm)].length, 1);
});

test("a candidate-bound capacity continuation resumes only its own candidate", async (t) => {
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    candidates: [
      candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], "capacity-once", {
        extra: ["capacity-marker"],
      }),
      ...reviewerPool(),
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9907"]);
  const { engine } = engineFor(root, configPath);

  const outcome = await engine.run("task-9907", { waitForCapacity: true });

  assert.equal(outcome.kind, "done");
  const implementer = (await ledgerDecisions(root)).filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.equal(implementer.length, 1);
  assert.deepEqual(
    implementer[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause", "launch", "completion"],
  );
  const sessionId = "claude-fake-claude-standard-task-9907-implementer";
  assert.equal(implementer[0].events[1].session_id, sessionId);
  assert.equal(implementer[0].events[3].session_id, sessionId);
});

test("the configured route limits end in the documented exhausted halt", async (t) => {
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    limits: { fallbacks_per_action: 1, escalations_per_task: 2 },
    candidates: [
      candidate("claude-a-implementer", "claude", "fake-claude-a", "high", ["implementer"], "provider-failure"),
      candidate("codex-b-implementer", "codex", "fake-codex-b", "high", ["implementer"], "provider-failure"),
      candidate("claude-c-implementer", "claude", "fake-claude-c", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9910"]);
  const { engine } = engineFor(root, configPath);

  const outcome = await engine.run("task-9910");

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /Bounded routing exhausted after provider_failure/);
  const decisions = await ledgerDecisions(root);
  assert.deepEqual(
    decisions.map((entry) => entry.chosen.candidate),
    ["claude-a-implementer", "codex-b-implementer"],
  );
  assert.deepEqual(
    decisions[1].events.map(({ kind }) => kind),
    ["launch", "failure", "exhausted"],
  );
});

// --- operator overrides ---------------------------------------------------------

test("an unsafe Planner downgrade override fails closed before any dispatch", async (t) => {
  const config = routingConfig({
    candidates: [
      candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
    hints: [planningHint("task-9902")],
  });
  const { root, configPath } = await repository(t, config, ["task-9902"]);
  const { engine } = engineFor(root, configPath, {
    routeOverrides: [
      { selector: { task: "task-9902", role: "implementer" }, candidate: "claude-lower-implementer" },
    ],
  });

  const outcome = await engine.run("task-9902");

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /violates hard safety gates/);
  assert.match(outcome.reason, /tier_below_minimum/);
  assert.equal(existsSync(routingDecisionsPath(root)), false);
  assert.equal(existsSync(path.join(root, ".aios", "runtime", "sessions.json")), false);
});

test("an unsafe Reviewer downgrade override fails closed after the Implementer decision", async (t) => {
  const config = routingConfig({
    candidates: [
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      candidate("claude-lower-reviewer", "claude", "fake-claude-lower", "lower", ["reviewer"], "complete", {
        cost: "economy",
      }),
      ...reviewerPool(),
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9906"]);
  const { engine } = engineFor(root, configPath, {
    routeOverrides: [
      { selector: { task: "task-9906", role: "reviewer" }, candidate: "claude-lower-reviewer" },
    ],
  });

  const outcome = await engine.run("task-9906");

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /violates hard safety gates/);
  assert.match(outcome.reason, /tier_below_minimum, tier_below_reviewer_floor/);
  const decisions = await ledgerDecisions(root);
  assert.deepEqual(
    decisions.map((entry) => [entry.key.role, entry.status]),
    [["implementer", "completed"]],
  );
});

test("override precedence is exact before wildcard and CLI before config, with audited displacement", async (t) => {
  const candidates = [
    candidate("claude-a-implementer", "claude", "fake-claude-a", "high", ["implementer"], "complete"),
    candidate("claude-b-implementer", "claude", "fake-claude-b", "high", ["implementer"], "complete"),
    candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
    ...reviewerPool(),
  ];
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    candidates,
    overrides: [
      {
        selector: { task: "task-9911", role: "implementer" },
        candidate: "codex-standard-implementer",
        allow_fallback: true,
      },
      {
        selector: { task: "task-9913", role: "implementer" },
        candidate: "codex-standard-implementer",
        allow_fallback: true,
      },
      {
        selector: { task: "*", role: "implementer" },
        candidate: "claude-b-implementer",
        allow_fallback: true,
      },
    ],
  });
  const { root, configPath } = await repository(t, config, [
    "task-9911",
    "task-9912",
    "task-9913",
  ]);

  // Exact configured selector beats the wildcard for task-9911.
  assert.equal((await engineFor(root, configPath).engine.run("task-9911")).kind, "done");
  // Only the wildcard matches task-9912.
  assert.equal((await engineFor(root, configPath).engine.run("task-9912")).kind, "done");
  // A CLI override displaces the equally specific configured override.
  const cliRun = engineFor(root, configPath, {
    routeOverrides: [
      { selector: { task: "task-9913", role: "implementer" }, candidate: "claude-b-implementer" },
    ],
  });
  assert.equal((await cliRun.engine.run("task-9913")).kind, "done");

  const decisions = await ledgerDecisions(root);
  const implementerFor = (task) =>
    decisions.find((entry) => entry.key.task === task && entry.key.role === "implementer");

  const exact = implementerFor("task-9911");
  assert.equal(exact.chosen.candidate, "codex-standard-implementer");
  assert.equal(exact.override.source, "config");
  assert.deepEqual(exact.override.selector, { task: "task-9911", role: "implementer" });
  assert.equal(exact.override.policy_winner.candidate, "claude-a-implementer");
  assert.equal(
    exact.override.displaced_rationale,
    "override displaced normal policy winner claude-a-implementer",
  );

  const wildcard = implementerFor("task-9912");
  assert.equal(wildcard.chosen.candidate, "claude-b-implementer");
  assert.deepEqual(wildcard.override.selector, { task: "*", role: "implementer" });

  const cli = implementerFor("task-9913");
  assert.equal(cli.chosen.candidate, "claude-b-implementer");
  assert.equal(cli.override.source, "cli");
  assert.equal(cli.override.allow_fallback, false);
  assert.equal(cli.override.displaced_config_candidate, "codex-standard-implementer");
  assert.equal(cli.override.hard_gates_passed, true);
});

test("a fallback-allowed override follows the bounded route while a denying override stops", async (t) => {
  const candidates = [
    candidate("claude-flaky-implementer", "claude", "fake-claude-flaky", "high", ["implementer"], "provider-failure"),
    candidate("claude-a-implementer", "claude", "fake-claude-a", "high", ["implementer"], "complete"),
    candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
    ...reviewerPool(),
  ];
  const config = routingConfig({
    tiers: [{ id: "high", rank: 1 }],
    candidates,
    overrides: [
      {
        selector: { task: "task-9914", role: "implementer" },
        candidate: "claude-flaky-implementer",
        allow_fallback: true,
      },
    ],
  });
  const { root, configPath } = await repository(t, config, ["task-9914", "task-9915"]);

  assert.equal((await engineFor(root, configPath).engine.run("task-9914")).kind, "done");
  const denied = await engineFor(root, configPath, {
    routeOverrides: [
      { selector: { task: "task-9915", role: "implementer" }, candidate: "claude-flaky-implementer" },
    ],
  }).engine.run("task-9915");

  assert.equal(denied.kind, "halted");
  assert.match(
    denied.reason,
    /pinned candidate claude-flaky-implementer and denies fallback after provider_failure/,
  );

  const decisions = await ledgerDecisions(root);
  const allowedSteps = decisions.filter(
    (entry) => entry.key.task === "task-9914" && entry.key.role === "implementer",
  );
  assert.equal(allowedSteps[0].override.allow_fallback, true);
  assert.equal(allowedSteps[0].status, "failed");
  assert.equal(allowedSteps[1].chosen.candidate, "codex-standard-implementer");
  assert.equal(allowedSteps[1].reason.code, "provider_failure");

  const deniedSteps = decisions.filter(
    (entry) => entry.key.task === "task-9915" && entry.key.role === "implementer",
  );
  assert.equal(deniedSteps.length, 1);
  assert.deepEqual(
    deniedSteps[0].events.map(({ kind, reason }) => [kind, reason?.code ?? null]),
    [
      ["launch", null],
      ["failure", "provider_failure"],
      ["exhausted", "routing_exhausted"],
    ],
  );
});

// --- one real progress invocation over an adopted plan ---------------------------

function planDocument(planId) {
  return `---
schema: aios.plan/v1
id: ${planId}
project: routing-e2e
profile: software-feature
profile_reason: The fixture proves the assembled routed CLI workflow.
---

# Routed progression plan

## Brief

Complete two routed Tasks in order.

## Profile Application

Each proposal is a focused, independently verifiable software outcome.

## Assumptions and Risks

The deterministic fake provider Workers are available from the source checkout.

## Decomposition Rationale

Two small Tasks expose ordering while remaining within one Worker session each.

## Execution Order

1. P-01 runs first.
2. P-02 runs second.
`;
}

function proposalDocument(id) {
  return `---
schema: aios.task/v1
id: ${id}
project: routing-e2e
title: Deliver ${id}
state: implement
retry: {count: 0, limit: 2}
approval: not_required
last_review: null
---

# Deliver ${id}

## Objective

Deliver one deterministic routed proposal outcome.

## Acceptance Criteria

- The fake provider Worker completes the Task.

## Constraints

- Remain inside the fixture repository.

## Context

This proposal exercises real adopt and progress CLI entry points.

## Attempts

_None yet._
`;
}

function cliCommand(root, args) {
  return executeFile(process.execPath, [cli, ...args], { cwd: root, windowsHide: true });
}

test("an adopted two-Task plan completes through one routed progress invocation with full audit", async (t) => {
  const planId = "routing-e2e-plan";
  const config = routingConfig({
    candidates: [
      candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("codex-lower-implementer", "codex", "fake-codex-lower", "lower", ["implementer"], "complete", {
        cost: "economy",
      }),
      candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
      candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
      ...reviewerPool(),
    ],
    hints: [implementationHint(null, { plan: planId })],
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument("task-0001", { project: "routing-e2e" }),
    "utf8",
  );
  const planDirectory = path.join(root, "plans", planId);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(path.join(planDirectory, "PLAN.md"), planDocument(planId), "utf8");
  await writeFile(path.join(planDirectory, "P-01.md"), proposalDocument("P-01"), "utf8");
  await writeFile(path.join(planDirectory, "P-02.md"), proposalDocument("P-02"), "utf8");
  await writeFile(
    path.join(root, ".aios", "assignments.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  // A standalone routed run first proves the CLI's non-null routing summary.
  const standalone = await cliCommand(root, ["run", "task-0001", "--root", root]);
  const standaloneReport = JSON.parse(standalone.stdout);
  assert.equal(standaloneReport.kind, "done");
  assert.equal(standaloneReport.routing.task, "task-0001");
  assert.equal(standaloneReport.routing.role, "reviewer");
  assert.equal(standaloneReport.routing.override, null);
  assert.ok(standaloneReport.routing.candidate);

  const adoption = JSON.parse(
    (await cliCommand(root, ["adopt", `plans/${planId}`, "--root", root])).stdout,
  );
  assert.deepEqual(adoption.mapping, { "P-01": "task-0002", "P-02": "task-0003" });

  // Exactly one real progress invocation drives the whole adopted plan.
  const progressed = await cliCommand(root, ["progress", `plans/${planId}`, "--root", root]);
  const report = JSON.parse(progressed.stdout);
  assert.deepEqual(report.completed, ["task-0002", "task-0003"]);
  assert.equal(report.complete, true);
  assert.equal(report.stop_reason, "plan_complete");
  assert.ok(Object.hasOwn(report, "routing"));
  assert.equal(report.routing, null);

  const store = new TaskStore(root);
  assert.equal((await store.loadTask("task-0002")).metadata.state, "done");
  assert.equal((await store.loadTask("task-0003")).metadata.state, "done");

  const decisions = await ledgerDecisions(root);
  const ordered = decisions.map((entry) => [entry.key.task, entry.key.role]);
  assert.deepEqual(ordered, [
    ["task-0001", "implementer"],
    ["task-0001", "reviewer"],
    ["task-0002", "implementer"],
    ["task-0002", "reviewer"],
    ["task-0003", "implementer"],
    ["task-0003", "reviewer"],
  ]);
  for (const task of ["task-0002", "task-0003"]) {
    const implementer = decisions.find(
      (entry) => entry.key.task === task && entry.key.role === "implementer",
    );
    const reviewer = decisions.find(
      (entry) => entry.key.task === task && entry.key.role === "reviewer",
    );
    assert.equal(implementer.chosen.tier, "lower");
    assert.equal(reviewer.chosen.tier, "high");
    assert.notEqual(reviewer.chosen.provider, implementer.chosen.provider);
  }

  // Every completed decision correlates with a session ledger row that names
  // the same fake model, Task, and Role.
  const sessions = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  ).sessions;
  for (const decision of decisions) {
    assert.equal(decision.status, "completed");
    const completion = decision.events.find((event) => event.kind === "completion");
    assert.ok(completion.session_id);
    const session = sessions.find((row) => row.id === completion.session_id);
    assert.equal(session.task, decision.key.task);
    assert.equal(session.role, decision.key.role);
    assert.equal(session.model, decision.chosen.model);
    assert.equal(session.outcome, "completed");
  }

  const dashboardOut = path.join(root, "dashboard.html");
  await cliCommand(root, ["dashboard", "--root", root, "--out", dashboardOut]);
  const html = await readFile(dashboardOut, "utf8");
  assert.match(html, /class="routing-section"/);
  assert.match(html, /Decisions by Task and Role/);
  assert.ok(html.includes(decisions[0].chosen.candidate));
});

// --- legacy compatibility ---------------------------------------------------------

async function legacyRepository(t, taskIds) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  for (const id of taskIds) {
    await writeFile(
      path.join(root, ".aios", "tasks", `${id}.md`),
      taskDocument(id, { project: "legacy-e2e" }),
      "utf8",
    );
  }
  return root;
}

function legacyAssignments(implementerMode) {
  return {
    schema: "aios.assignments/v1",
    assignments: {
      implementer: [process.execPath, legacyWorker, implementerMode],
      reviewer: [process.execPath, legacyWorker, "auto-loop"],
    },
  };
}

test("the legacy assignments command path is byte-for-byte unaffected by routing", async (t) => {
  const root = await legacyRepository(t, ["task-0001", "task-0002"]);
  await writeFile(
    path.join(root, ".aios", "assignments.json"),
    JSON.stringify(legacyAssignments("auto-loop")),
    "utf8",
  );

  const done = await cliCommand(root, ["run", "task-0001", "--root", root]);
  assert.deepEqual(JSON.parse(done.stdout), {
    kind: "done",
    task: "task-0001",
    state: "done",
    reason: null,
  });

  const deferredPath = path.join(root, "deferred-assignments.json");
  await writeFile(deferredPath, JSON.stringify(legacyAssignments("deferred")), "utf8");
  let waiting;
  try {
    await cliCommand(root, [
      "run",
      "task-0002",
      "--root",
      root,
      "--assignments",
      deferredPath,
    ]);
  } catch (error) {
    waiting = error;
  }
  assert.equal(waiting.code, 75);
  const waitingReport = JSON.parse(waiting.stdout);
  assert.equal(waitingReport.kind, "waiting");
  assert.equal(waitingReport.task, "task-0002");
  assert.ok(waitingReport.retry_at);
  assert.equal(Object.hasOwn(waitingReport, "routing"), false);

  const sessions = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  ).sessions;
  assert.deepEqual(
    sessions.map(({ id, outcome }) => [id, outcome]),
    [["fixture-implementer", "capacity_deferred"]],
  );
  assert.equal(existsSync(routingDecisionsPath(root)), false);
});

test("the same legacy command path behaves identically before and after routing runs beside it", async (t) => {
  const root = await legacyRepository(t, ["task-0001", "task-0002", "task-0003"]);
  await writeFile(
    path.join(root, ".aios", "assignments.json"),
    JSON.stringify(legacyAssignments("auto-loop")),
    "utf8",
  );
  const routingPath = path.join(root, "routing.json");
  await writeFile(
    routingPath,
    JSON.stringify(
      routingConfig({
        tiers: [{ id: "high", rank: 1 }],
        candidates: [
          candidate("claude-standard-implementer", "claude", "fake-claude-standard", "high", ["implementer"], "complete"),
          candidate("codex-standard-implementer", "codex", "fake-codex-standard", "high", ["implementer"], "complete"),
          ...reviewerPool(),
        ],
      }),
    ),
    "utf8",
  );

  const before = await cliCommand(root, ["run", "task-0001", "--root", root]);
  const routed = await cliCommand(root, [
    "run",
    "task-0002",
    "--root",
    root,
    "--assignments",
    routingPath,
  ]);
  const after = await cliCommand(root, ["run", "task-0003", "--root", root]);

  const beforeReport = JSON.parse(before.stdout);
  const afterReport = JSON.parse(after.stdout);
  assert.deepEqual(
    { ...beforeReport, task: "task" },
    { ...afterReport, task: "task" },
  );
  assert.equal(Object.hasOwn(beforeReport, "routing"), false);
  assert.equal(Object.hasOwn(afterReport, "routing"), false);
  assert.notEqual(JSON.parse(routed.stdout).routing, null);

  const store = new TaskStore(root);
  for (const id of ["task-0001", "task-0002", "task-0003"]) {
    assert.equal((await store.loadTask(id)).metadata.state, "done");
  }
  // Routing audit rows exist only for the routed Task; the legacy runs added
  // no routing evidence and no session rows of their own.
  const decisions = await ledgerDecisions(root);
  assert.ok(decisions.length > 0);
  assert.ok(decisions.every((entry) => entry.key.task === "task-0002"));
  const sessions = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  ).sessions;
  assert.ok(sessions.every((row) => row.task === "task-0002"));
});
