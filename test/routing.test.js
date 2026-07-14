import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore } from "../src/documents.js";
import {
  buildWorkloadContext,
  loadExecutionConfig,
  parseExecutionConfig,
  RoutingConfigError,
  validateRoutingConfig,
} from "../src/routing.js";
import { FileAssignmentResolver } from "../src/workers.js";

function clone(value) {
  return structuredClone(value);
}

function baseConfig() {
  return {
    schema: "aios.routing/v1",
    tiers: [
      { id: "lower", rank: 1 },
      { id: "high", rank: 2 },
    ],
    capabilities: ["filesystem", "shell"],
    cost_classes: ["low", "standard", "high"],
    latency_classes: ["fast", "standard"],
    candidates: [
      {
        id: "claude-lower",
        provider: "claude",
        model: "configured-claude-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "workers/claude-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "claude-high",
        provider: "claude",
        model: "configured-claude-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "workers/claude-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "standard",
      },
      {
        id: "codex-lower",
        provider: "codex",
        model: "configured-codex-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "workers/codex-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "codex-high",
        provider: "codex",
        model: "configured-codex-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "workers/codex-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "standard",
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
      default_budgets: { cost: "standard", latency: "standard" },
    },
    hints: [],
    overrides: [],
  };
}

function taskBody({ titleOnly = false, planning = false, repeat = "" } = {}) {
  if (planning) {
    return `
# Plan routing${repeat}

## Objective

Produce a reviewed plan under plans/demo-routing/.

## Acceptance Criteria

- \`node src/cli.js adopt plans/demo-routing --check\` passes.

## Constraints

- The Implementer writes only under plans/demo-routing/.

## Context

Planning fixture.

## Attempts

_None yet._
`;
  }
  return `
# ${titleOnly ? "Plan a title only" : "Bounded implementation"}${repeat}

## Objective

Implement one bounded behavior.${repeat}

## Acceptance Criteria

- \`node --test test/example.test.js\` passes.

## Constraints

- Keep the change focused.

## Context

Fixture context.

## Attempts

_None yet._
`;
}

function makeTask({
  id = "task-9001",
  project = "routing-test",
  approval = "not_required",
  retry = { count: 0, limit: 2 },
  body = taskBody(),
} = {}) {
  const metadata = {
    schema: "aios.task/v1",
    id,
    project,
    title: "Routing fixture",
    state: "implement",
    retry,
    approval,
    last_review: retry.count === 0 ? null : "review-9001",
  };
  const raw = `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
  return Object.freeze({ metadata: Object.freeze(metadata), body, raw });
}

function fullHint({
  task = "task-9001",
  plan = null,
  workKind = "implementation",
  complexity = "low",
  risk = "low",
  verification = "objective",
} = {}) {
  return {
    selector: { task: plan === null ? task : null, plan },
    work_kind: workKind,
    complexity,
    risk,
    required_capabilities: ["filesystem"],
    verification,
    cost_budget: "low",
    latency_budget: "fast",
  };
}

function validReview(verdict, id = "review-9001", attempt = 1) {
  return {
    metadata: {
      schema: "aios.review/v1",
      id,
      project: "routing-test",
      task: "task-9001",
      attempt,
      verdict,
    },
    body: `Reviewed with verdict ${verdict}.`,
  };
}

function validSession(outcome, id = `session-${outcome}`) {
  return {
    id,
    task: "task-9001",
    role: "implementer",
    model: "configured-model",
    first_seen_at: "2026-07-14T00:00:00.000Z",
    last_seen_at: "2026-07-14T00:00:01.000Z",
    invocations: 1,
    outcome,
    usage: null,
    cost_usd: null,
    capacity: null,
  };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  return root;
}

async function persistTask(root, task) {
  await writeFile(
    path.join(root, ".aios", "tasks", `${task.metadata.id}.md`),
    task.raw,
    "utf8",
  );
}

async function persistAdoptedPlan(root, task, planId, profile = "software-feature") {
  const directory = path.join(root, "plans", planId);
  await mkdir(directory, { recursive: true });
  const metadata = {
    schema: "aios.plan/v1",
    id: planId,
    project: task.metadata.project,
    profile,
    profile_reason: "Routing fixture profile.",
  };
  const body = `
# ${planId}

## Brief

Fixture.

## Profile Application

Fixture.

## Assumptions and Risks

Fixture.

## Decomposition Rationale

Fixture.

## Execution Order

1. ${task.metadata.id} is routed.
`;
  await writeFile(
    path.join(directory, "PLAN.md"),
    `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`,
    "utf8",
  );
}

test("routing config accepts explicit Claude and Codex catalogs without inferring models", () => {
  const input = baseConfig();
  const validated = validateRoutingConfig(input);

  assert.equal(validated.schema, "aios.routing/v1");
  assert.deepEqual(validated.candidates.map(({ provider }) => provider), [
    "claude",
    "claude",
    "codex",
    "codex",
  ]);
  assert.deepEqual(validated.candidates.map(({ model }) => model), [
    "configured-claude-lower",
    "configured-claude-high",
    "configured-codex-lower",
    "configured-codex-high",
  ]);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.candidates[0].command));
});

test("routing config rejects unknown fields with their exact path", () => {
  const top = baseConfig();
  top.surprise = true;
  assert.throws(() => validateRoutingConfig(top), /routing\.surprise: is not allowed/);

  const nested = baseConfig();
  nested.candidates[0].surprise = true;
  assert.throws(
    () => validateRoutingConfig(nested),
    /routing\.candidates\[0\]\.surprise: is not allowed/,
  );
});

test("routing config validates catalogs, references, commands, weights, and limits", () => {
  const cases = [
    ["duplicate tier id", (c) => c.tiers.push({ id: "lower", rank: 3 }), /duplicate ids/],
    ["duplicate tier rank", (c) => c.tiers.push({ id: "highest", rank: 2 }), /duplicate ranks/],
    ["unknown tier", (c) => (c.candidates[0].tier = "ghost"), /unknown tier ghost/],
    [
      "unknown capability",
      (c) => c.candidates[0].capabilities.push("network"),
      /unknown value network/,
    ],
    ["unknown cost", (c) => (c.candidates[0].cost_class = "free"), /unknown cost class/],
    [
      "unknown latency",
      (c) => (c.candidates[0].latency_class = "instant"),
      /unknown latency class/,
    ],
    ["duplicate candidate", (c) => (c.candidates[1].id = c.candidates[0].id), /duplicate id/],
    [
      "duplicate provider model role",
      (c) => {
        c.candidates[1].model = c.candidates[0].model;
        c.candidates[1].roles = ["implementer"];
      },
      /duplicates provider\/model\/Role/,
    ],
    ["invalid argv", (c) => (c.candidates[0].command = []), /non-empty argv/],
    [
      "no reviewer",
      (c) => c.candidates.forEach((candidate) => (candidate.roles = ["implementer"])),
      /no enabled candidate for Role reviewer/,
    ],
    ["zero weight", (c) => (c.policy.provider_targets[0].weight = 0), /finite positive/],
    [
      "missing target",
      (c) => c.policy.provider_targets.splice(1, 1),
      /missing provider codex/,
    ],
    [
      "unknown target",
      (c) => (c.policy.provider_targets[1].provider = "other"),
      /missing provider codex|unknown provider other/,
    ],
    ["zero window", (c) => (c.policy.distribution_window = 0), /positive safe integer/],
    [
      "zero fallback",
      (c) => (c.policy.limits.fallbacks_per_action = 0),
      /positive safe integer/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const config = baseConfig();
    mutate(config);
    assert.throws(() => validateRoutingConfig(config), pattern, name);
  }
});

test("routing config covers remaining scalar, enum, reference, and duplicate rules", () => {
  const cases = [
    ["tier id", (c) => (c.tiers[0].id = "Bad Tier"), /invalid value/],
    ["tier rank", (c) => (c.tiers[0].rank = -1), /positive safe integer/],
    ["capability duplicate", (c) => c.capabilities.push("shell"), /must not contain duplicates/],
    ["cost duplicate", (c) => c.cost_classes.push("low"), /must not contain duplicates/],
    ["latency duplicate", (c) => c.latency_classes.push("fast"), /must not contain duplicates/],
    ["candidate provider", (c) => (c.candidates[0].provider = "Bad Provider"), /invalid value/],
    ["candidate model", (c) => (c.candidates[0].model = ""), /non-empty string/],
    ["candidate enabled", (c) => (c.candidates[0].enabled = "yes"), /must be a boolean/],
    ["candidate context", (c) => (c.candidates[0].context_limit = 0), /positive safe integer/],
    ["candidate Role", (c) => (c.candidates[0].roles = ["approver"]), /unknown value approver/],
    ["high tier", (c) => (c.policy.high_tier = "ghost"), /unknown tier ghost/],
    [
      "duplicate provider target",
      (c) => (c.policy.provider_targets[1].provider = "claude"),
      /duplicate providers/,
    ],
    ["default cost", (c) => (c.policy.default_budgets.cost = "free"), /unknown cost class/],
    [
      "default latency",
      (c) => (c.policy.default_budgets.latency = "instant"),
      /unknown latency class/,
    ],
    [
      "hint selects both",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].selector.plan = "demo";
      },
      /exactly one Task or plan/,
    ],
    [
      "hint work kind",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].work_kind = "coding";
      },
      /work_kind: has an unknown value/,
    ],
    [
      "hint complexity",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].complexity = "tiny";
      },
      /complexity: has an unknown value/,
    ],
    [
      "hint risk",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].risk = "critical";
      },
      /risk: has an unknown value/,
    ],
    [
      "hint verification",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].verification = "maybe";
      },
      /verification: has an unknown value/,
    ],
    [
      "hint cost",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].cost_budget = "free";
      },
      /unknown cost class/,
    ],
    [
      "hint latency",
      (c) => {
        c.hints.push(fullHint());
        c.hints[0].latency_budget = "instant";
      },
      /unknown latency class/,
    ],
    [
      "override candidate",
      (c) => c.overrides.push({
        selector: { task: "*", role: "implementer" },
        candidate: "ghost",
        allow_fallback: true,
      }),
      /unknown candidate ghost/,
    ],
    [
      "override boolean",
      (c) => c.overrides.push({
        selector: { task: "*", role: "implementer" },
        candidate: "codex-lower",
        allow_fallback: "yes",
      }),
      /allow_fallback: must be a boolean/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const config = baseConfig();
    mutate(config);
    assert.throws(() => validateRoutingConfig(config), pattern, name);
  }
});

test("routing config rejects unknown fields in every nested object group", () => {
  const cases = [
    (c) => (c.tiers[0].extra = true),
    (c) => (c.policy.extra = true),
    (c) => (c.policy.limits.extra = true),
    (c) => (c.policy.default_budgets.extra = true),
    (c) => (c.policy.provider_targets[0].extra = true),
    (c) => {
      c.hints.push(fullHint());
      c.hints[0].extra = true;
    },
    (c) => {
      c.hints.push(fullHint());
      c.hints[0].selector.extra = true;
    },
    (c) => {
      c.overrides.push({
        selector: { task: "*", role: "implementer" },
        candidate: "codex-lower",
        allow_fallback: true,
        extra: true,
      });
    },
    (c) => {
      c.overrides.push({
        selector: { task: "*", role: "implementer", extra: true },
        candidate: "codex-lower",
        allow_fallback: true,
      });
    },
  ];
  for (const mutate of cases) {
    const config = baseConfig();
    mutate(config);
    assert.throws(() => validateRoutingConfig(config), /\.extra: is not allowed/);
  }
});

test("hints stay provider neutral and overrides validate selectors and candidates", () => {
  const valid = baseConfig();
  valid.hints.push(fullHint());
  valid.overrides.push({
    selector: { task: "task-9001", role: "reviewer" },
    candidate: "codex-high",
    allow_fallback: true,
  });
  assert.equal(validateRoutingConfig(valid).hints[0].work_kind, "implementation");

  const duplicateHint = clone(valid);
  duplicateHint.hints.push(fullHint());
  assert.throws(() => validateRoutingConfig(duplicateHint), /duplicate selector task:task-9001/);

  const badHint = baseConfig();
  badHint.hints.push(fullHint());
  badHint.hints[0].required_capabilities = ["network"];
  assert.throws(() => validateRoutingConfig(badHint), /unknown value network/);

  const badSelector = clone(valid);
  badSelector.overrides[0].selector.task = "bad";
  assert.throws(() => validateRoutingConfig(badSelector), /selector\.task: has an invalid/);

  const ineligible = clone(valid);
  ineligible.overrides[0].candidate = "codex-lower";
  assert.throws(() => validateRoutingConfig(ineligible), /ineligible for Role reviewer/);

  const duplicateOverride = clone(valid);
  duplicateOverride.overrides.push(clone(duplicateOverride.overrides[0]));
  assert.throws(() => validateRoutingConfig(duplicateOverride), /duplicate selector/);
});

test("execution config preserves legacy assignments and activates routing only by schema", async (t) => {
  const root = await temporaryRoot(t);
  const assignmentPath = path.join(root, "assignments.json");
  const assignment = {
    schema: "aios.assignments/v1",
    assignments: { implementer: [process.execPath, "fixture.js"] },
  };
  const bytes = `${JSON.stringify(assignment, null, 2)}\n`;
  await writeFile(assignmentPath, bytes, "utf8");

  const parsed = await loadExecutionConfig(assignmentPath);
  assert.equal(parsed.kind, "assignments");
  assert.deepEqual(parsed.config, assignment);
  assert.equal(await readFile(assignmentPath, "utf8"), bytes);

  const resolver = new FileAssignmentResolver(assignmentPath, { cwd: root });
  assert.deepEqual((await resolver.resolve("implementer")).command, assignment.assignments.implementer);
  assert.equal(parseExecutionConfig(baseConfig()).kind, "routing");
  assert.throws(
    () => parseExecutionConfig({ schema: "aios.unknown/v1" }),
    RoutingConfigError,
  );
});

test("strict planning contract and explicit planning hints enforce the high tier", async (t) => {
  const root = await temporaryRoot(t);
  const config = baseConfig();
  const strict = makeTask({ body: taskBody({ planning: true }) });
  const strictContext = await buildWorkloadContext({
    task: strict,
    role: "implementer",
    root,
    config,
  });
  assert.equal(strictContext.work_kind, "planning");
  assert.equal(strictContext.minimum_tier, "high");
  assert.equal(strictContext.diagnostics.strict_planning_contract, true);

  const wrappedBody = taskBody({ planning: true })
    .replace(
      "Produce a reviewed plan under plans/demo-routing/.",
      "Produce a reviewed `software-feature` plan under\n`plans/demo-routing/`.",
    )
    .replace(
      "The Implementer writes only under plans/demo-routing/.",
      "This is a planning Task. The Implementer writes only under\n`plans/demo-routing/`; it does not modify source files.",
    );
  const wrappedContext = await buildWorkloadContext({
    task: makeTask({ body: wrappedBody }),
    role: "implementer",
    root,
    config,
  });
  assert.equal(wrappedContext.diagnostics.strict_planning_contract, true);
  assert.equal(wrappedContext.minimum_tier, "high");

  const hinted = baseConfig();
  hinted.hints.push(fullHint({ workKind: "planning", complexity: "low", risk: "low" }));
  const hintedContext = await buildWorkloadContext({
    task: makeTask(),
    role: "implementer",
    root,
    config: hinted,
  });
  assert.equal(hintedContext.work_kind, "planning");
  assert.equal(hintedContext.minimum_tier, "high");
});

test("a planning title alone is unknown and conflicting planning evidence fails closed", async (t) => {
  const root = await temporaryRoot(t);
  const titleOnly = await buildWorkloadContext({
    task: makeTask({ body: taskBody({ titleOnly: true }) }),
    role: "implementer",
    root,
    config: baseConfig(),
  });
  assert.equal(titleOnly.work_kind, "unknown");
  assert.equal(titleOnly.minimum_tier, "high");

  const conflictConfig = baseConfig();
  conflictConfig.hints.push(fullHint({ workKind: "implementation" }));
  const conflict = await buildWorkloadContext({
    task: makeTask({ body: taskBody({ planning: true }) }),
    role: "implementer",
    root,
    config: conflictConfig,
  });
  assert.equal(conflict.work_kind, "unknown");
  assert.ok(conflict.uncertainty_flags.includes("work_kind_conflict"));
  assert.equal(conflict.minimum_tier, "high");
});

test("planning detection rejects split commands, wrong paths, and negative write prose", async (t) => {
  const root = await temporaryRoot(t);
  const valid = taskBody({ planning: true });
  const bodies = [
    valid.replace(
      "`node src/cli.js adopt plans/demo-routing --check`",
      "`node src/cli.js adopt plans/demo-routing` and `--check`",
    ),
    valid.replace("adopt plans/demo-routing --check", "adopt plans/other-routing --check"),
    valid.replace(
      "The Implementer writes only under plans/demo-routing/.",
      "The Implementer must not write only under plans/demo-routing/.",
    ),
    valid.replace(
      "Produce a reviewed plan under plans/demo-routing/.",
      "Do not produce a reviewed plan under plans/demo-routing/.",
    ),
    valid.replace(
      "Produce a reviewed plan under plans/demo-routing/.",
      "Inspect the plan under plans/demo-routing/ without changing it.",
    ),
    valid.replace(
      "Produce a reviewed plan under plans/demo-routing/.",
      "Produce no plan under plans/demo-routing/.",
    ),
    valid.replace(
      "Produce a reviewed plan under plans/demo-routing/.",
      "Produce an inspection report of the plan under plans/demo-routing/.",
    ),
  ];
  for (const body of bodies) {
    const context = await buildWorkloadContext({
      task: makeTask({ body }),
      role: "implementer",
      root,
      config: baseConfig(),
    });
    assert.equal(context.diagnostics.strict_planning_contract, false);
    assert.equal(context.work_kind, "unknown");
    assert.equal(context.minimum_tier, "high");
  }
});

test("only a fully evidenced bounded implementation becomes lower-tier eligible", async (t) => {
  const root = await temporaryRoot(t);
  const config = baseConfig();
  config.hints.push(fullHint());
  const task = makeTask();
  const context = await buildWorkloadContext({
    task,
    role: "implementer",
    root,
    config,
  });

  assert.equal(context.work_kind, "implementation");
  assert.equal(context.complexity, "low");
  assert.equal(context.risk, "low");
  assert.equal(context.verification_burden, "objective");
  assert.equal(context.lower_tier.eligible, true);
  assert.deepEqual(context.lower_tier.rejection_reasons, []);
  assert.equal(context.minimum_tier, "lower");
  assert.deepEqual(context.budgets, { cost: "low", latency: "fast" });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.sources));

  const same = await buildWorkloadContext({ task, role: "implementer", root, config });
  assert.deepEqual(same, context);
});

test("each unknown, risky, unverified, large, review, or session signal rejects lower tier", async (t) => {
  const root = await temporaryRoot(t);
  const scenarios = [
    {
      name: "unknown complexity",
      configure: (hint) => (hint.complexity = "unknown"),
      task: makeTask(),
      reviews: [],
      sessions: [],
      reason: "complexity_not_low",
    },
    {
      name: "high risk",
      configure: (hint) => (hint.risk = "high"),
      task: makeTask(),
      reviews: [],
      sessions: [],
      reason: "risk_not_low",
    },
    {
      name: "subjective verification",
      configure: (hint) => (hint.verification = "subjective"),
      task: makeTask(),
      reviews: [],
      sessions: [],
      reason: "verification_not_objective",
    },
    {
      name: "large context",
      configure: () => {},
      task: makeTask({ body: taskBody({ repeat: "x".repeat(33_000) }) }),
      reviews: [],
      sessions: [],
      reason: "context_not_bounded",
    },
    {
      name: "required approval",
      configure: () => {},
      task: makeTask({ approval: "required" }),
      reviews: [],
      sessions: [],
      reason: "risk_not_low",
    },
    {
      name: "existing retry",
      configure: () => {},
      task: makeTask({ retry: { count: 1, limit: 2 } }),
      reviews: [],
      sessions: [],
      reason: "unresolved_failure_history",
    },
    {
      name: "changes review",
      configure: () => {},
      task: makeTask(),
      reviews: [validReview("changes_requested")],
      sessions: [],
      reason: "unresolved_failure_history",
    },
    {
      name: "failed session",
      configure: () => {},
      task: makeTask(),
      reviews: [],
      sessions: [validSession("failed")],
      reason: "unresolved_failure_history",
    },
    {
      name: "malformed history",
      configure: () => {},
      task: makeTask(),
      reviews: [{ metadata: { task: "task-9001", verdict: "unknown" } }],
      sessions: [{ task: "task-9001", outcome: "mystery" }],
      reason: "unresolved_failure_history",
    },
  ];

  for (const scenario of scenarios) {
    const config = baseConfig();
    const hint = fullHint();
    scenario.configure(hint);
    config.hints.push(hint);
    const context = await buildWorkloadContext({
      task: scenario.task,
      role: "implementer",
      root,
      config,
      reviews: scenario.reviews,
      sessions: scenario.sessions,
    });
    assert.equal(context.minimum_tier, "high", scenario.name);
    assert.ok(
      context.lower_tier.rejection_reasons.includes(scenario.reason),
      scenario.name,
    );
  }
});

test("parent plan discovery returns one validated profile and plan hints apply", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);
  await persistAdoptedPlan(root, task, "parent-plan", "bug-fix");
  const config = baseConfig();
  config.hints.push(fullHint({ task: null, plan: "parent-plan" }));

  const context = await buildWorkloadContext({
    task: await new TaskStore(root).loadTask(task.metadata.id),
    role: "implementer",
    root,
    config,
  });
  assert.deepEqual(context.parent_plan, { id: "parent-plan", profile: "bug-fix" });
  assert.equal(context.sources.work_kind, "routing.hints.plan:parent-plan");
  assert.equal(context.minimum_tier, "lower");
});

test("ambiguous or malformed adopted plans fail parent assessment closed", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);
  await persistAdoptedPlan(root, task, "parent-one");
  await persistAdoptedPlan(root, task, "parent-two");
  const config = baseConfig();
  config.hints.push(fullHint());
  const storedTask = await new TaskStore(root).loadTask(task.metadata.id);

  const ambiguous = await buildWorkloadContext({
    task: storedTask,
    role: "implementer",
    root,
    config,
  });
  assert.equal(ambiguous.parent_plan, null);
  assert.ok(ambiguous.uncertainty_flags.includes("parent_plan_ambiguous"));
  assert.equal(ambiguous.minimum_tier, "high");

  await rm(path.join(root, "plans", "parent-two"), { recursive: true, force: true });
  await writeFile(path.join(root, "plans", "parent-one", "PLAN.md"), "not yaml", "utf8");
  const malformed = await buildWorkloadContext({
    task: storedTask,
    role: "implementer",
    root,
    config,
  });
  assert.ok(malformed.uncertainty_flags.includes("parent_plan_invalid"));
  assert.equal(malformed.minimum_tier, "high");
  assert.ok(malformed.diagnostics.plan_errors.length > 0);
});

test("an adopted plan with invalid metadata fails the existing plan validator closed", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);
  await persistAdoptedPlan(root, task, "invalid-header");
  const planPath = path.join(root, "plans", "invalid-header", "PLAN.md");
  const raw = await readFile(planPath, "utf8");
  await writeFile(planPath, raw.replace("schema: aios.plan/v1", "schema: wrong/v1"), "utf8");
  const config = baseConfig();
  config.hints.push(fullHint());

  const context = await buildWorkloadContext({
    task: await new TaskStore(root).loadTask(task.metadata.id),
    role: "implementer",
    root,
    config,
  });
  assert.equal(context.minimum_tier, "high");
  assert.ok(context.uncertainty_flags.includes("parent_plan_invalid"));
  assert.match(context.diagnostics.plan_errors.join("\n"), /schema must be aios\.plan\/v1/);
});

test("an adopted plan missing a required body section fails closed", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);
  await persistAdoptedPlan(root, task, "missing-brief");
  const planPath = path.join(root, "plans", "missing-brief", "PLAN.md");
  const raw = await readFile(planPath, "utf8");
  await writeFile(planPath, raw.replace("## Brief\n\nFixture.\n\n", ""), "utf8");
  const config = baseConfig();
  config.hints.push(fullHint());

  const context = await buildWorkloadContext({
    task: await new TaskStore(root).loadTask(task.metadata.id),
    role: "implementer",
    root,
    config,
  });
  assert.equal(context.minimum_tier, "high");
  assert.ok(context.uncertainty_flags.includes("parent_plan_invalid"));
  assert.match(context.diagnostics.plan_errors.join("\n"), /non-empty Brief section/);
});

test("a partially adopted Execution Order is malformed instead of a tolerated missing parent", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);
  await persistAdoptedPlan(root, task, "hybrid-plan");
  const planPath = path.join(root, "plans", "hybrid-plan", "PLAN.md");
  const raw = await readFile(planPath, "utf8");
  await writeFile(
    planPath,
    raw.replace(
      `1. ${task.metadata.id} is routed.`,
      `1. P-01 is pending.\n2. ${task.metadata.id} is already adopted.`,
    ),
    "utf8",
  );
  const config = baseConfig();
  config.hints.push(fullHint());

  const context = await buildWorkloadContext({
    task: await new TaskStore(root).loadTask(task.metadata.id),
    role: "implementer",
    root,
    config,
  });
  assert.equal(context.minimum_tier, "high");
  assert.ok(context.uncertainty_flags.includes("parent_plan_invalid"));
  assert.match(
    context.diagnostics.plan_errors.join("\n"),
    /mixes proposal placeholders with an adopted Task Execution Order/,
  );
});

test("multiple discovered plans and errors produce sorted stable diagnostics", async (t) => {
  const root = await temporaryRoot(t);
  const task = makeTask();
  await persistTask(root, task);

  await persistAdoptedPlan(root, task, "z-invalid");
  await writeFile(path.join(root, "plans", "z-invalid", "PLAN.md"), "not yaml", "utf8");
  await persistAdoptedPlan(root, task, "a-hybrid");
  const hybridPath = path.join(root, "plans", "a-hybrid", "PLAN.md");
  const hybrid = await readFile(hybridPath, "utf8");
  await writeFile(
    hybridPath,
    hybrid.replace(
      `1. ${task.metadata.id} is routed.`,
      `1. P-01 is pending.\n2. ${task.metadata.id} is adopted.`,
    ),
    "utf8",
  );
  await persistAdoptedPlan(root, task, "m-invalid-header");
  const metadataPath = path.join(root, "plans", "m-invalid-header", "PLAN.md");
  const metadata = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, metadata.replace("schema: aios.plan/v1", "schema: bad/v1"), "utf8");

  const config = baseConfig();
  config.hints.push(fullHint());
  const storedTask = await new TaskStore(root).loadTask(task.metadata.id);
  const first = await buildWorkloadContext({
    task: storedTask,
    role: "implementer",
    root,
    config,
  });
  const second = await buildWorkloadContext({
    task: storedTask,
    role: "implementer",
    root,
    config,
  });

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.diagnostics.plan_errors,
    [...first.diagnostics.plan_errors].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    first.diagnostics.plan_errors.map((error) => error.split(":", 1)[0]),
    ["a-hybrid", "m-invalid-header", "z-invalid"],
  );
  assert.equal(first.minimum_tier, "high");
});

test("workload output exposes complete source labels and prior outcome counters", async (t) => {
  const root = await temporaryRoot(t);
  const config = baseConfig();
  config.hints.push(fullHint());
  const context = await buildWorkloadContext({
    task: makeTask(),
    role: "reviewer",
    root,
    config,
    reviews: [
      validReview("pass", "review-9001", 1),
      validReview("changes_requested", "review-9002", 2),
    ],
    sessions: [
      validSession("failed", "session-failed"),
      validSession("capacity_deferred", "session-capacity"),
    ],
  });
  assert.deepEqual(context.history, {
    reviews_total: 2,
    changes_requested: 1,
    sessions_failed: 1,
    capacity_deferred: 1,
  });
  assert.deepEqual(Object.keys(context.sources).sort(), [
    "approval",
    "budgets",
    "complexity",
    "context_size",
    "diagnostics",
    "history",
    "lower_tier",
    "minimum_tier",
    "parent_plan",
    "required_capabilities",
    "retry",
    "risk",
    "role",
    "task_id",
    "uncertainty_flags",
    "verification_burden",
    "work_kind",
  ]);
  assert.equal(context.risk, "high");
  assert.ok(context.lower_tier.rejection_reasons.includes("role_not_implementer"));
});
