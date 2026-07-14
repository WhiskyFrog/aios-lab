import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { collectDashboardData, renderDashboard } from "../src/dashboard.js";
import { TaskStore } from "../src/documents.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");
const workerFixture = path.join(projectRoot, "fixtures", "command-worker.js");
const humanApprover = path.join(projectRoot, "workers", "human-approver.mjs");

function document(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function proposal(id, { approval = "not_required" } = {}) {
  return document(
    {
      schema: "aios.task/v1",
      id,
      project: "e2e-project",
      title: `Deliver ${id}`,
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval,
      last_review: null,
    },
    `
# Deliver ${id}

## Objective

Deliver one deterministic integration-test outcome.

## Acceptance Criteria

- The command Worker completes the Task.

## Constraints

- Use only the fixture repository.

## Context

This proposal exercises real adopt and progress CLI entry points.

## Attempts

_None yet._
`,
  );
}

async function makeFixture(t, { plan = "e2e-plan", approvals = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-progression-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  const planDirectory = path.join(root, "plans", plan);
  await mkdir(planDirectory, { recursive: true });
  const proposalIds = approvals.length === 0 ? ["P-01", "P-02"] : approvals.map((_, i) => `P-${String(i + 1).padStart(2, "0")}`);
  await writeFile(
    path.join(planDirectory, "PLAN.md"),
    document(
      {
        schema: "aios.plan/v1",
        id: plan,
        project: "e2e-project",
        profile: "software-feature",
        profile_reason: "The fixture proves an executable software workflow.",
      },
      `
# E2E plan

## Brief

Prove real adoption and ordered progression.

## Profile Application

Each proposal is a focused, independently reviewed software outcome.

## Assumptions and Risks

The deterministic command fixture is available from the source checkout.

## Decomposition Rationale

Two small Tasks expose ordering while remaining within one Worker session each.

## Execution Order

${proposalIds.map((id, index) => `${index + 1}. ${id} runs in order.`).join("\n")}
`,
    ),
    "utf8",
  );
  for (const [index, id] of proposalIds.entries()) {
    await writeFile(
      path.join(planDirectory, `${id}.md`),
      proposal(id, { approval: approvals[index] ?? "not_required" }),
      "utf8",
    );
  }
  return { root, plan, proposalIds };
}

async function writeAssignments(root, assignments) {
  const target = path.join(root, ".aios", "assignments.json");
  await writeFile(
    target,
    JSON.stringify({ schema: "aios.assignments/v1", assignments }),
    "utf8",
  );
  return target;
}

function cliCommand(root, ...args) {
  return executeFile(process.execPath, [cli, ...args], {
    cwd: root,
    windowsHide: true,
  });
}

async function adopt(root, plan) {
  const result = await cliCommand(root, "adopt", `plans/${plan}`, "--root", root);
  return JSON.parse(result.stdout);
}

function planProgressSection(html) {
  return /<section class="plan-progress-section"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

test("real adopt then one progress command completes two Tasks in order", async (t) => {
  const { root, plan } = await makeFixture(t);
  const adoption = await adopt(root, plan);
  assert.deepEqual(adoption.mapping, { "P-01": "task-0001", "P-02": "task-0002" });
  await writeAssignments(root, {
    implementer: [process.execPath, workerFixture, "auto-loop"],
    reviewer: [process.execPath, workerFixture, "auto-loop"],
  });

  const { stdout, stderr } = await cliCommand(
    root,
    "progress",
    `plans/${plan}`,
    "--root",
    root,
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    plan,
    completed: ["task-0001", "task-0002"],
    complete: true,
    task: null,
    stop_reason: "plan_complete",
    action: "No action needed: every Task in the plan is done.",
  });
  const store = new TaskStore(root);
  assert.equal((await store.loadTask("task-0001")).metadata.state, "done");
  assert.equal((await store.loadTask("task-0002")).metadata.state, "done");
});

test("approval stop and dashboard durable state report the exact same action", async (t) => {
  const { root, plan } = await makeFixture(t, {
    plan: "approval-e2e",
    approvals: ["required"],
  });
  await adopt(root, plan);
  await writeAssignments(root, {
    implementer: [process.execPath, workerFixture, "auto-loop"],
    reviewer: [process.execPath, workerFixture, "auto-loop"],
    approver: [process.execPath, humanApprover],
  });

  let stopped;
  try {
    await cliCommand(root, "progress", `plans/${plan}`, "--root", root);
  } catch (error) {
    stopped = error;
  }
  assert.equal(stopped.code, 3);
  const report = JSON.parse(stopped.stdout);
  assert.equal(report.stop_reason, "awaiting_approval");
  assert.equal(report.task, "task-0001");
  assert.equal(
    report.action,
    `Create ${path.join(root, ".aios", "approvals", "task-0001")} containing exactly ` +
      `"approved" or "rejected", then rerun progression.`,
  );

  const data = await collectDashboardData(root);
  const dashboardPlan = data.planProgress.find((entry) => entry.id === plan);
  assert.equal(dashboardPlan.currentCategory, report.stop_reason);
  assert.equal(dashboardPlan.action, report.action);
  const section = planProgressSection(renderDashboard(data));
  assert.match(section, /Awaiting approval/);
  assert.match(section, /Operator action:/);
  assert.doesNotMatch(section, /cancell|repository(?:-mutation)? conflict/i);
});

test("capacity live stop becomes historical dashboard evidence without an action", async (t) => {
  const { root, plan } = await makeFixture(t, {
    plan: "capacity-e2e",
    approvals: ["not_required"],
  });
  await adopt(root, plan);
  await writeAssignments(root, {
    implementer: [process.execPath, workerFixture, "deferred"],
  });

  let stopped;
  try {
    await cliCommand(root, "progress", `plans/${plan}`, "--root", root);
  } catch (error) {
    stopped = error;
  }
  assert.equal(stopped.code, 5);
  const report = JSON.parse(stopped.stdout);
  assert.equal(report.stop_reason, "capacity_wait");

  const data = await collectDashboardData(root);
  const dashboardPlan = data.planProgress.find((entry) => entry.id === plan);
  assert.equal(dashboardPlan.currentCategory, null);
  assert.equal(dashboardPlan.action, null);
  assert.equal(dashboardPlan.lastObserved.outcome, "capacity_deferred");
  const section = planProgressSection(renderDashboard(data));
  assert.match(section, /Last observed/);
  assert.match(section, /historical, not live status/);
  assert.doesNotMatch(section, /Operator action:/);
  assert.doesNotMatch(section, /cancell|repository(?:-mutation)? conflict/i);
});
