// Disposable end-to-end demonstration of adaptive model routing.
//
//   node fixtures/routing-demo.js
//
// The harness creates a temporary AIOS root with a routing configuration,
// fake Claude and Codex command Workers, a planning Task, an adoptable
// two-proposal plan, and general Tasks, then drives the real CLI entry
// points as child processes with exact argv arrays. It observes high-tier
// planning, lower-tier bounded implementation with cross-provider review,
// sequential plan progression, an audited CLI override, capacity fallback
// under a configured override, session correlation, and dashboard rendering.
// No network, credential, or paid provider process is ever launched, and the
// temporary root is removed in `finally`. The report replaces machine-local
// paths with placeholders.
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(sourceRoot, "src", "cli.js");
const routingWorker = path.join(sourceRoot, "fixtures", "routing-worker.js");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aios-routing-demo-"));
const planId = "routing-demo";
const planDirectory = path.join(temporaryRoot, "plans", planId);

function candidate(id, provider, model, tier, roles, mode, { cost = "standard", latency = "standard" } = {}) {
  return {
    id,
    provider,
    model,
    tier,
    roles,
    command: [process.execPath, routingWorker, provider, model, mode],
    enabled: true,
    context_limit: 200_000,
    capabilities: [],
    cost_class: cost,
    latency_class: latency,
  };
}

const routingConfig = {
  schema: "aios.routing/v1",
  tiers: [
    { id: "lower", rank: 1 },
    { id: "high", rank: 2 },
  ],
  capabilities: [],
  cost_classes: ["economy", "standard"],
  latency_classes: ["standard", "slow"],
  candidates: [
    candidate("claude-lower-implementer", "claude", "fake-claude-lower", "lower", ["implementer"], "complete", { cost: "economy" }),
    candidate("codex-lower-implementer", "codex", "fake-codex-lower", "lower", ["implementer"], "complete", { cost: "economy" }),
    candidate("claude-high-implementer", "claude", "fake-claude-high", "high", ["implementer"], "complete"),
    candidate("codex-high-implementer", "codex", "fake-codex-high", "high", ["implementer"], "complete"),
    candidate("claude-flaky-implementer", "claude", "fake-claude-lower-flaky", "lower", ["implementer"], "capacity-always", { cost: "economy", latency: "slow" }),
    candidate("claude-high-reviewer", "claude", "fake-claude-high", "high", ["reviewer"], "complete"),
    candidate("codex-high-reviewer", "codex", "fake-codex-high", "high", ["reviewer"], "complete"),
  ],
  policy: {
    high_tier: "high",
    distribution_window: 12,
    provider_targets: [
      { provider: "claude", weight: 1 },
      { provider: "codex", weight: 1 },
    ],
    limits: { fallbacks_per_action: 3, escalations_per_task: 2 },
    default_budgets: { cost: "standard", latency: "slow" },
  },
  hints: [
    {
      selector: { task: "task-0001", plan: null },
      work_kind: "planning",
      complexity: "high",
      risk: "high",
      required_capabilities: [],
      verification: "subjective",
      cost_budget: "standard",
      latency_budget: "slow",
    },
    {
      selector: { task: null, plan: planId },
      work_kind: "implementation",
      complexity: "low",
      risk: "low",
      required_capabilities: [],
      verification: "objective",
      cost_budget: "standard",
      latency_budget: "slow",
    },
    {
      selector: { task: "task-0005", plan: null },
      work_kind: "implementation",
      complexity: "low",
      risk: "low",
      required_capabilities: [],
      verification: "objective",
      cost_budget: "standard",
      latency_budget: "slow",
    },
  ],
  overrides: [
    {
      selector: { task: "task-0005", role: "implementer" },
      candidate: "claude-flaky-implementer",
      allow_fallback: true,
    },
  ],
};

function taskDocument(id, title) {
  return `---
schema: aios.task/v1
id: ${id}
project: ${planId}
title: ${title}
state: implement
retry: {count: 0, limit: 2}
approval: not_required
last_review: null
---

# ${title}

## Objective

Deliver one deterministic routed demo outcome.

## Acceptance Criteria

- The fake provider Worker completes the Task.

## Constraints

- Remain inside the temporary demo root.

## Context

Disposable adaptive-routing demonstration.

## Attempts

_None yet._
`;
}

function proposalDocument(id) {
  return taskDocument(id, `Deliver ${id}`);
}

const planDocument = `---
schema: aios.plan/v1
id: ${planId}
project: ${planId}
profile: software-feature
profile_reason: Prove the assembled routed CLI workflow end to end.
---

# Routing demo plan

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

const report = {
  demonstration: "adaptive model routing end to end with fake Claude and Codex Workers",
  temporary_root: "<demo-root>",
  setup: {
    files: [],
    routing_config: ".aios/assignments.json (schema aios.routing/v1)",
    fake_workers: "fixtures/routing-worker.js launched via argv arrays; no network or paid call",
    ledgers_clean_at_start: null,
  },
  commands: [],
  observations: {},
  cleanup: {
    action: "node:fs/promises.rm(<demo-root>, { recursive: true, force: true }) in finally",
    temporary_root_removed: false,
  },
};

function sanitize(text) {
  const variants = (value) => [
    value,
    value.replaceAll("\\", "\\\\"),
    value.replaceAll("\\", "/"),
  ];
  let sanitized = text;
  for (const variant of variants(temporaryRoot)) {
    sanitized = sanitized.replaceAll(variant, "<demo-root>");
  }
  for (const variant of variants(sourceRoot)) {
    sanitized = sanitized.replaceAll(variant, "<aios-source>");
  }
  for (const variant of variants(process.execPath)) {
    sanitized = sanitized.replaceAll(variant, "<node>");
  }
  return sanitized;
}

async function runCli(name, cliArguments) {
  const argv = [process.execPath, cli, ...cliArguments];
  const executed = await executeFile(process.execPath, [cli, ...cliArguments], {
    cwd: temporaryRoot,
    windowsHide: true,
  });
  const stdout = executed.stdout.trim();
  const entry = {
    name,
    argv,
    exit_code: 0,
    stdout: stdout.startsWith("{") ? JSON.parse(stdout) : stdout,
  };
  report.commands.push(entry);
  return entry.stdout;
}

async function writeSetupFile(relativePath, content) {
  const target = path.join(temporaryRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  report.setup.files.push(relativePath.replaceAll("\\", "/"));
}

async function taskState(id) {
  const raw = await readFile(path.join(temporaryRoot, ".aios", "tasks", `${id}.md`), "utf8");
  return parse(raw.split("---", 3)[1]).state;
}

try {
  try {
    await mkdir(path.join(temporaryRoot, ".aios", "tasks"), { recursive: true });
    await mkdir(path.join(temporaryRoot, ".aios", "reviews"), { recursive: true });
    await writeSetupFile(
      path.join(".aios", "assignments.json"),
      `${JSON.stringify(routingConfig, null, 2)}\n`,
    );
    await writeSetupFile(
      path.join(".aios", "tasks", "task-0001.md"),
      taskDocument("task-0001", "Plan the routing demo follow-up"),
    );
    await writeSetupFile(path.join("plans", planId, "PLAN.md"), planDocument);
    await writeSetupFile(path.join("plans", planId, "P-01.md"), proposalDocument("P-01"));
    await writeSetupFile(path.join("plans", planId, "P-02.md"), proposalDocument("P-02"));
    report.setup.ledgers_clean_at_start =
      !existsSync(path.join(temporaryRoot, ".aios", "runtime", "routing-decisions.json")) &&
      !existsSync(path.join(temporaryRoot, ".aios", "runtime", "sessions.json"));

    const adoption = await runCli("adopt", [
      "adopt",
      path.join("plans", planId),
      "--root",
      temporaryRoot,
    ]);

    const planningRun = await runCli("run planning task", [
      "run",
      "task-0001",
      "--root",
      temporaryRoot,
    ]);

    const progression = await runCli("progress adopted plan (single invocation)", [
      "progress",
      path.join("plans", planId),
      "--root",
      temporaryRoot,
    ]);

    await writeSetupFile(
      path.join(".aios", "tasks", "task-0004.md"),
      taskDocument("task-0004", "Deliver the override demo Task"),
    );
    const overrideRun = await runCli("run with CLI route override", [
      "run",
      "task-0004",
      "--root",
      temporaryRoot,
      "--route-override",
      "task-0004:implementer=codex-high-implementer",
    ]);

    await writeSetupFile(
      path.join(".aios", "tasks", "task-0005.md"),
      taskDocument("task-0005", "Deliver the capacity fallback demo Task"),
    );
    const fallbackRun = await runCli("run with configured override and capacity fallback", [
      "run",
      "task-0005",
      "--root",
      temporaryRoot,
    ]);

    const dashboardPath = await runCli("dashboard", [
      "dashboard",
      "--root",
      temporaryRoot,
      "--out",
      path.join(temporaryRoot, "dashboard.html"),
    ]);

    const ledger = JSON.parse(
      await readFile(
        path.join(temporaryRoot, ".aios", "runtime", "routing-decisions.json"),
        "utf8",
      ),
    );
    const sessions = JSON.parse(
      await readFile(path.join(temporaryRoot, ".aios", "runtime", "sessions.json"), "utf8"),
    ).sessions;
    const decisionFor = (task, role, step = null) =>
      ledger.decisions.find(
        (entry) =>
          entry.key.task === task &&
          entry.key.role === role &&
          (step === null || entry.step === step),
      );

    const planning = decisionFor("task-0001", "implementer");
    report.observations.planning_high_tier = {
      adoption_mapping: adoption.mapping,
      run_report: planningRun,
      work_kind: planning.workload.work_kind,
      chosen: planning.chosen,
      lower_candidate_hard_gate: planning.considered
        .filter((entry) => entry.tier === "lower")
        .map(({ candidate: id, reasons }) => ({ candidate: id, reasons })),
    };

    report.observations.plan_progression = {
      report: progression,
      tasks: {},
    };
    for (const task of progression.completed) {
      const implementer = decisionFor(task, "implementer");
      const reviewer = decisionFor(task, "reviewer");
      report.observations.plan_progression.tasks[task] = {
        implementer: implementer.chosen,
        reviewer: reviewer.chosen,
        reviewer_other_provider: reviewer.chosen.provider !== implementer.chosen.provider,
        implementer_lower_tier: implementer.chosen.tier === "lower",
      };
    }

    const overridden = decisionFor("task-0004", "implementer");
    report.observations.cli_override = {
      run_report: overrideRun,
      chosen: overridden.chosen,
      override: overridden.override,
    };

    const pinned = decisionFor("task-0005", "implementer", 0);
    const fallback = decisionFor("task-0005", "implementer", 1);
    report.observations.capacity_fallback = {
      run_report: fallbackRun,
      pinned_step: {
        chosen: pinned.chosen,
        status: pinned.status,
        events: pinned.events.map(({ kind }) => kind),
        override_source: pinned.override.source,
        allow_fallback: pinned.override.allow_fallback,
      },
      fallback_step: {
        chosen: fallback.chosen,
        reason: fallback.reason,
        cross_provider_same_tier:
          fallback.chosen.provider !== pinned.chosen.provider &&
          fallback.chosen.tier === pinned.chosen.tier,
      },
      continuation_safety:
        "the codex fallback completed, so no claude-bound continuation crossed providers " +
        "(fixtures/routing-worker.js exits nonzero when a foreign continuation arrives)",
    };

    const completed = ledger.decisions.filter((entry) => entry.status === "completed");
    report.observations.audit_session_correlation = {
      decisions_total: ledger.decisions.length,
      completed_decisions: completed.length,
      every_completion_linked_to_matching_session: completed.every((decision) => {
        const completion = decision.events.find((event) => event.kind === "completion");
        const session = sessions.find((row) => row.id === completion?.session_id);
        return (
          session !== undefined &&
          session.task === decision.key.task &&
          session.role === decision.key.role &&
          session.model === decision.chosen.model
        );
      }),
      session_rows: sessions.length,
      total_session_cost_usd: sessions.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    };

    const dashboardHtml = await readFile(path.join(temporaryRoot, "dashboard.html"), "utf8");
    report.observations.dashboard = {
      written: dashboardPath.replaceAll("\\", "/").endsWith("dashboard.html"),
      renders_routing_section: dashboardHtml.includes('class="routing-section"'),
      renders_decisions_by_task: dashboardHtml.includes("Decisions by Task and Role"),
    };

    report.observations.final_task_states = {};
    for (const id of ["task-0001", "task-0002", "task-0003", "task-0004", "task-0005"]) {
      report.observations.final_task_states[id] = await taskState(id);
    }
    report.observations.reviews_created = (
      await import("node:fs/promises").then(({ readdir }) =>
        readdir(path.join(temporaryRoot, ".aios", "reviews")),
      )
    ).length;
    report.observations.no_paid_sessions =
      "all Worker processes were fixtures/routing-worker.js child processes with cost_usd 0";
  } catch (error) {
    report.error = String(error?.stderr ?? error?.message ?? error);
    process.exitCode = 1;
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  try {
    await access(temporaryRoot);
  } catch {
    report.cleanup.temporary_root_removed = true;
  }
}

process.stdout.write(`${sanitize(JSON.stringify(report, null, 2))}\n`);
