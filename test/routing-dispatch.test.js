import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import { candidateCooldownsPath } from "../src/routing-cooldown-store.js";
import { CANDIDATE_COOLDOWNS_SCHEMA } from "../src/routing-cooldowns.js";
import { routingDecisionsPath } from "../src/routing-ledger.js";
import { FileAssignmentResolver } from "../src/workers.js";

async function seedCooldowns(root, cooldowns) {
  const filePath = candidateCooldownsPath(root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      { schema: CANDIDATE_COOLDOWNS_SCHEMA, updated_at: "2026-07-16T00:00:00.000Z", cooldowns },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const TASK_ID = "task-9800";
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "command-worker.js",
);

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

function config(candidates, extra = {}) {
  const providers = [...new Set(candidates.map(({ provider }) => provider))];
  return {
    schema: "aios.routing/v1",
    tiers: extra.tiers ?? [{ id: "high", rank: 1 }],
    capabilities: [],
    cost_classes: ["standard"],
    latency_classes: ["standard"],
    candidates,
    policy: {
      high_tier: "high",
      distribution_window: 10,
      provider_targets: providers.map((provider) => ({ provider, weight: 1 })),
      limits: extra.limits ?? { fallbacks_per_action: 3, escalations_per_task: 2 },
      default_budgets: { cost: "standard", latency: "standard" },
    },
    hints: extra.hints ?? [],
    overrides: [],
  };
}

function lowerTierHint() {
  return {
    selector: { task: TASK_ID, plan: null },
    work_kind: "implementation",
    complexity: "low",
    risk: "low",
    required_capabilities: [],
    verification: "objective",
    cost_budget: "standard",
    latency_budget: "standard",
  };
}

function taskDocument({ retryCount = 0, seedAttempt = false } = {}) {
  const metadata = {
    schema: "aios.task/v1",
    id: TASK_ID,
    project: "routing-test",
    title: "Route one action",
    state: "implement",
    retry: { count: retryCount, limit: 2 },
    approval: "not_required",
    last_review: seedAttempt ? "review-9800" : null,
  };
  const body = `
# Route one action

## Objective

Exercise bounded routed dispatch.

## Acceptance Criteria

- The accepted Result is projected once.

## Attempts

${
  seedAttempt
    ? `<!-- aios:attempt-frame v1 number=1 summary=40 verification=33 -->
### Attempt 1

#### Summary

Implemented through the command adapter.

#### Verification

The end-to-end command completed.
<!-- /aios:attempt-frame v1 number=1 -->`
    : "_None yet._"
}
`;
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

async function repository(t, routingConfig, taskOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", `${TASK_ID}.md`),
    taskDocument(taskOptions),
    "utf8",
  );
  if (taskOptions.seedAttempt) {
    const reviewMetadata = {
      schema: "aios.review/v1",
      id: "review-9800",
      project: "routing-test",
      task: TASK_ID,
      attempt: 1,
      verdict: "changes_requested",
    };
    await writeFile(
      path.join(root, ".aios", "reviews", "review-9800.md"),
      `---\n${stringify(reviewMetadata, { lineWidth: 0 }).trimEnd()}\n---\n\n# Review\n\n## Findings\n\nCorrect the repeated evidence.\n`,
      "utf8",
    );
  }
  const configPath = path.join(root, "routing.json");
  await writeFile(configPath, `${JSON.stringify(routingConfig, null, 2)}\n`, "utf8");
  return { root, configPath };
}

test("routed Role loop falls back across providers and correlates audit sessions", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "deferred"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
    candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await new TaskStore(root).loadTask(TASK_ID);
  assert.match(task.body, /### Attempt 1/);
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.deepEqual(
    implementer.map((entry) => [entry.chosen.candidate, entry.status]),
    [
      ["a-implementer", "failed"],
      ["b-implementer", "completed"],
    ],
  );
  assert.deepEqual(
    implementer[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause", "failure", "fallback"],
  );
  assert.equal(implementer[0].events[1].session_id, "fixture-implementer");
  assert.deepEqual(
    implementer[1].events.map(({ kind }) => kind),
    ["launch", "completion"],
  );
});

for (const [label, mode, reason] of [
  ["verification failure", "verification-failure", "verification_failed"],
  ["context failure", "context-failure", "context_insufficient"],
]) {
  test(`${label} escalates directly to a strictly higher tier`, async (t) => {
    const routingConfig = config(
      [
        candidate("a-lower-implementer", "alpha", ["implementer"], mode, "lower"),
        candidate("b-high-implementer", "beta", ["implementer"], "corrected-loop"),
        candidate("c-high-reviewer", "gamma", ["reviewer"], "auto-loop"),
        candidate("d-high-reviewer", "delta", ["reviewer"], "auto-loop"),
      ],
      {
        tiers: [
          { id: "lower", rank: 10 },
          { id: "high", rank: 30 },
        ],
        hints: [lowerTierHint()],
      },
    );
    const { root, configPath } = await repository(t, routingConfig);
    const assignments = new FileAssignmentResolver(configPath, { cwd: root });

    const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

    assert.equal(outcome.kind, "done");
    const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
    const implementer = ledger.decisions.filter(
      (entry) => entry.key.role === "implementer",
    );
    assert.deepEqual(
      implementer.map((entry) => [entry.chosen.tier, entry.reason?.code ?? null]),
      [
        ["lower", null],
        ["high", reason],
      ],
    );
    assert.deepEqual(
      implementer[0].events.map(({ kind }) => kind),
      ["launch", "failure", "escalation"],
    );
  });
}

for (const [label, mode, timeoutMs] of [
  ["timeout", "hang", 400],
  ["provider failure", "nonzero", 300_000],
]) {
  test(`${label} falls back to a fresh same-tier provider`, async (t) => {
    const routingConfig = config([
      candidate("a-implementer", "alpha", ["implementer"], mode),
      candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
      candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
      candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
    ]);
    const { root, configPath } = await repository(t, routingConfig);
    const assignments = new FileAssignmentResolver(configPath, {
      cwd: root,
      timeoutMs,
    });

    const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

    assert.equal(outcome.kind, "done");
    const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
    const implementer = ledger.decisions.filter(
      (entry) => entry.key.role === "implementer",
    );
    assert.equal(implementer[1].chosen.provider, "beta");
    assert.equal(
      implementer[1].reason.code,
      mode === "hang" ? "timeout" : "provider_failure",
    );
  });
}

test("a rejected Review raises the next existing attempt to the high tier", async (t) => {
  const routingConfig = config(
    [
      candidate("a-lower-implementer", "alpha", ["implementer"], "auto-loop", "lower"),
      candidate("b-high-implementer", "beta", ["implementer"], "corrected-loop"),
      candidate("c-high-reviewer", "gamma", ["reviewer"], "review-by-attempt"),
      candidate("d-high-reviewer", "delta", ["reviewer"], "review-by-attempt"),
    ],
    {
      tiers: [
        { id: "lower", rank: 1 },
        { id: "high", rank: 2 },
      ],
      hints: [lowerTierHint()],
    },
  );
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.deepEqual(
    implementer.map((entry) => [entry.key.attempt, entry.chosen.tier]),
    [
      [1, "lower"],
      [2, "high"],
    ],
  );
  const task = await new TaskStore(root).loadTask(TASK_ID);
  assert.equal(task.metadata.retry.count, 1);
  assert.equal((await new TaskStore(root).listReviews()).length, 2);
});

test("capacity with no alternate route resumes only the same candidate", async (t) => {
  const resumed = candidate("a-implementer", "alpha", ["implementer"], "capacity-loop");
  resumed.command.push("capacity-marker");
  const routingConfig = config([
    resumed,
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID, {
    waitForCapacity: true,
  });

  assert.equal(outcome.kind, "done");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.equal(implementer.length, 1);
  assert.deepEqual(
    implementer[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause", "launch", "completion"],
  );
  assert.equal(implementer[0].events[1].session_id, "fixture-implementer");
  assert.equal(implementer[0].events[2].session_id, "fixture-implementer");
});

test("capacity with no alternate route preserves the existing waiting outcome", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "deferred"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "waiting");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  assert.deepEqual(
    ledger.decisions[0].events.map(({ kind }) => kind),
    ["launch", "capacity_pause"],
  );
  assert.equal(ledger.decisions[0].status, "dispatched");
});

test("bounded exhaustion halts without retrying a candidate", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "nonzero"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /Bounded routing exhausted after provider_failure/);
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  assert.equal(ledger.decisions.length, 1);
  assert.deepEqual(
    ledger.decisions[0].events.map(({ kind }) => kind),
    ["launch", "failure", "exhausted"],
  );
});

test("the per-action fallback limit stops before another eligible candidate", async (t) => {
  const routingConfig = config(
    [
      candidate("a-implementer", "alpha", ["implementer"], "nonzero"),
      candidate("b-implementer", "beta", ["implementer"], "nonzero"),
      candidate("c-implementer", "gamma", ["implementer"], "fresh-loop"),
      candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
    ],
    { limits: { fallbacks_per_action: 1, escalations_per_task: 2 } },
  );
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  assert.deepEqual(
    ledger.decisions.map((entry) => entry.chosen.candidate),
    ["a-implementer", "b-implementer"],
  );
});

test("a legacy failure Result halts without guessing a recovery route", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "execution-failure"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.reason, "structured fixture failure");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  assert.equal(ledger.decisions.length, 1);
  assert.equal(ledger.decisions[0].events[1].reason.code, "worker_reported_failure");
});

test("a Task conflict prevents the next fallback launch", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "mutate-nonzero"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.category, "conflict");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  assert.equal(ledger.decisions.length, 1);
  assert.deepEqual(
    ledger.decisions[0].events.map(({ kind }) => kind),
    ["launch"],
  );
});

test("exact repeated Attempt evidence escalates to a stronger unused candidate", async (t) => {
  const routingConfig = config(
    [
      candidate("a-high-implementer", "alpha", ["implementer"], "auto-loop"),
      candidate(
        "b-premium-implementer",
        "beta",
        ["implementer"],
        "corrected-loop",
        "premium",
      ),
      candidate("c-premium-reviewer", "gamma", ["reviewer"], "auto-loop", "premium"),
    ],
    {
      tiers: [
        { id: "lower", rank: 1 },
        { id: "high", rank: 2 },
        { id: "premium", rank: 3 },
      ],
    },
  );
  const { root, configPath } = await repository(t, routingConfig, {
    retryCount: 1,
    seedAttempt: true,
  });
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.filter(
    (entry) => entry.key.role === "implementer",
  );
  assert.deepEqual(
    implementer.map((entry) => [entry.chosen.tier, entry.reason?.code ?? null]),
    [
      ["high", null],
      ["premium", "repeated_evidence"],
    ],
  );
});

test("a corroborated capacity event records a cooldown for the failing candidate", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "deferred"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
    candidate("d-reviewer", "delta", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });
  const before = Date.now();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const cooldowns = JSON.parse(await readFile(candidateCooldownsPath(root), "utf8"));
  assert.equal(cooldowns.schema, CANDIDATE_COOLDOWNS_SCHEMA);
  assert.equal(cooldowns.cooldowns.length, 1);
  const [cooldown] = cooldowns.cooldowns;
  assert.equal(cooldown.candidate, "a-implementer");
  assert.equal(cooldown.reason_code, "capacity");
  assert.ok(Date.parse(cooldown.retry_at) > before);
  assert.match(cooldown.evidence, /Worker capacity is unavailable until/);
});

test("an active cooldown skips the cooled-down candidate with the correct audit reason", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "fresh-loop"),
    candidate("b-implementer", "beta", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  await seedCooldowns(root, [
    {
      candidate: "a-implementer",
      retry_at: new Date(Date.now() + 3_600_000).toISOString(),
      reason_code: "capacity",
      evidence: "capacity exhausted after 3 consecutive attempts",
    },
  ]);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.find((entry) => entry.key.role === "implementer");
  assert.equal(implementer.chosen.candidate, "b-implementer");
  const consideredA = implementer.considered.find((entry) => entry.candidate === "a-implementer");
  assert.deepEqual(consideredA.reasons, ["candidate_cooldown_active"]);
  assert.equal(consideredA.eligible, false);
});

test("an expired cooldown no longer blocks selection", async (t) => {
  const routingConfig = config([
    candidate("a-implementer", "alpha", ["implementer"], "fresh-loop"),
    candidate("c-reviewer", "gamma", ["reviewer"], "auto-loop"),
  ]);
  const { root, configPath } = await repository(t, routingConfig);
  await seedCooldowns(root, [
    {
      candidate: "a-implementer",
      retry_at: new Date(Date.now() - 3_600_000).toISOString(),
      reason_code: "capacity",
      evidence: "capacity exhausted after 3 consecutive attempts",
    },
  ]);
  const assignments = new FileAssignmentResolver(configPath, { cwd: root });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const ledger = JSON.parse(await readFile(routingDecisionsPath(root), "utf8"));
  const implementer = ledger.decisions.find((entry) => entry.key.role === "implementer");
  assert.equal(implementer.chosen.candidate, "a-implementer");
  const considered = implementer.considered.find((entry) => entry.candidate === "a-implementer");
  assert.deepEqual(considered.reasons, []);
  assert.equal(considered.eligible, true);
});
