import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { main } from "../src/cli.js";
import { TaskStore } from "../src/documents.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(projectRoot, "fixtures", "command-worker.js");
const cli = path.join(projectRoot, "src", "cli.js");

function taskDocument() {
  const metadata = {
    schema: "aios.task/v1",
    id: "task-9001",
    project: "test-project",
    title: "Run from one command",
    state: "implement",
    retry: { count: 0, limit: 2 },
    approval: "not_required",
    last_review: null,
  };
  const body = [
    "",
    "# Run from one command",
    "",
    "## Objective",
    "",
    "Reach done without another operator trigger.",
    "",
    "## Acceptance Criteria",
    "",
    "- The command invokes both active Roles.",
    "",
    "## Attempts",
    "",
    "_None yet._",
    "",
  ].join("\n");
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

test("a usage error exits with code 64, distinct from blocked", async () => {
  await assert.rejects(
    executeFile(process.execPath, [cli, "run"], { windowsHide: true }),
    (error) => error.code === 64 && /Usage:/.test(error.stderr),
  );
});

test("capacity without opt-in exits 75 and reports retry_at without moving the Task", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-waiting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-9001.md"),
    taskDocument(),
    "utf8",
  );
  const assignmentsPath = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignmentsPath,
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: { implementer: [process.execPath, fixture, "deferred"] },
    }),
    "utf8",
  );

  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "run", "task-9001", "--root", root, "--assignments", assignmentsPath],
      { cwd: root, windowsHide: true },
    ),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 75 &&
        report.kind === "waiting" &&
        report.state === "implement" &&
        typeof report.retry_at === "string"
      );
    },
  );

  const task = await new TaskStore(root).loadTask("task-9001");
  assert.equal(task.metadata.state, "implement");
  assert.equal(task.metadata.retry.count, 0);
  const ledger = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  );
  assert.equal(ledger.sessions[0].outcome, "capacity_deferred");
});

test("--wait-for-capacity resumes exact sessions and completes the Role loop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-capacity-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-9001.md"),
    taskDocument(),
    "utf8",
  );
  const marker = path.join(root, "capacity-marker");
  const assignmentsPath = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignmentsPath,
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: {
        implementer: [process.execPath, fixture, "capacity-loop", marker],
        reviewer: [process.execPath, fixture, "capacity-loop", marker],
      },
    }),
    "utf8",
  );

  const { stdout } = await executeFile(
    process.execPath,
    [
      cli,
      "run",
      "task-9001",
      "--root",
      root,
      "--assignments",
      assignmentsPath,
      "--wait-for-capacity",
      "--max-capacity-wait-ms",
      "1000",
      "--max-capacity-pauses",
      "2",
    ],
    { cwd: root, windowsHide: true },
  );

  assert.equal(JSON.parse(stdout).kind, "done");
  const ledger = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  );
  assert.deepEqual(
    ledger.sessions.map((session) => [session.role, session.invocations]),
    [
      ["implementer", 2],
      ["reviewer", 2],
    ],
  );
});

test("one CLI trigger runs command Implementer and Reviewer through done", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-9001.md"),
    taskDocument(),
    "utf8",
  );

  const assignmentsPath = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignmentsPath,
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: {
        implementer: [process.execPath, fixture, "auto-loop"],
        reviewer: [process.execPath, fixture, "auto-loop"],
      },
    }),
    "utf8",
  );

  const { stdout, stderr } = await executeFile(
    process.execPath,
    [cli, "run", "task-9001", "--root", root, "--assignments", assignmentsPath],
    { cwd: root, windowsHide: true },
  );

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    kind: "done",
    task: "task-9001",
    state: "done",
    reason: null,
  });
  const store = new TaskStore(root);
  const task = await store.loadTask("task-9001");
  assert.equal(task.metadata.state, "done");
  assert.equal(task.metadata.last_review, "review-0001");
  assert.match(task.body, /Implemented through the command adapter/);
  assert.equal(
    (await store.loadReview("review-0001")).metadata.verdict,
    "pass",
  );
  assert.match(await readFile(assignmentsPath, "utf8"), /"reviewer"/);
});

test("repeated Implementer evidence halts the CLI before retry exhaustion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-repeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-9001.md"),
    taskDocument(),
    "utf8",
  );
  const assignmentsPath = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignmentsPath,
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: {
        implementer: [process.execPath, fixture, "repeat-loop"],
        reviewer: [process.execPath, fixture, "repeat-loop"],
      },
    }),
    "utf8",
  );

  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "run", "task-9001", "--root", root, "--assignments", assignmentsPath],
      { cwd: root, windowsHide: true },
    ),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 1 &&
        report.kind === "halted" &&
        report.state === "implement" &&
        /repeated the evidence from Attempt 1/.test(report.reason)
      );
    },
  );

  const store = new TaskStore(root);
  const task = await store.loadTask("task-9001");
  assert.equal(task.metadata.state, "implement");
  assert.equal(task.metadata.retry.count, 1);
  assert.match(task.body, /### Attempt 1/);
  assert.doesNotMatch(task.body, /### Attempt 2/);
  assert.equal((await store.listReviews()).length, 1);
});

const PROGRESS_PROJECT = "test-project";
const approverWorker = path.join(projectRoot, "workers", "human-approver.mjs");

function progressDocument(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function progressTaskMetadata(id, overrides = {}) {
  const retry = overrides.retry ?? { count: 0, limit: 2 };
  return {
    schema: "aios.task/v1",
    id,
    project: PROGRESS_PROJECT,
    title: `Exercise ${id}`,
    state: "implement",
    retry,
    approval: "not_required",
    last_review: null,
    ...overrides,
    retry,
  };
}

function progressTaskBody(attemptCount = 0) {
  const attempts = [];
  for (let number = 1; number <= attemptCount; number += 1) {
    attempts.push(
      `### Attempt ${number}\n\n#### Summary\n\nSeed ${number}.\n\n#### Verification\n\nSeeded.`,
    );
  }
  return [
    "",
    "# Exercise the loop",
    "",
    "## Objective",
    "",
    "Reach the expected terminal state.",
    "",
    "## Acceptance Criteria",
    "",
    "- The transition is persisted.",
    "",
    "## Attempts",
    "",
    attempts.length === 0 ? "_None yet._" : attempts.join("\n\n"),
    "",
  ].join("\n");
}

async function createProgressRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cli-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  return root;
}

async function writeProgressTask(root, metadata, attemptCount = 0) {
  const filePath = path.join(root, ".aios", "tasks", `${metadata.id}.md`);
  await writeFile(
    filePath,
    progressDocument(metadata, progressTaskBody(attemptCount)),
    "utf8",
  );
  return filePath;
}

async function seedProgressReview(root, { id, attempt, verdict, task }) {
  const metadata = {
    schema: "aios.review/v1",
    id,
    project: PROGRESS_PROJECT,
    task,
    attempt,
    verdict,
  };
  const body = `\n# Review of ${task}, Attempt ${attempt}\n\n## Findings\n\nSeeded ${verdict}.\n`;
  await writeFile(
    path.join(root, ".aios", "reviews", `${id}.md`),
    progressDocument(metadata, body),
    "utf8",
  );
}

async function writeProgressPlan(root, { id = "demo-plan", items, placeholders = false } = {}) {
  const dir = path.join(root, "plans", id);
  await mkdir(dir, { recursive: true });
  const metadata = {
    schema: "aios.plan/v1",
    id,
    project: PROGRESS_PROJECT,
    profile: "software-feature",
    profile_reason: "Testing CLI progression.",
  };
  const listed = placeholders
    ? items.map((_, index) => `P-${String(index + 1).padStart(2, "0")}`)
    : items;
  const list = listed
    .map((entry, index) => `${index + 1}. ${entry} advances step ${index + 1}.`)
    .join("\n");
  const body = [
    "",
    "# Demo plan",
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
  await writeFile(path.join(dir, "PLAN.md"), progressDocument(metadata, body), "utf8");
  return dir;
}

async function writeProgressAssignments(root, assignments) {
  const assignmentsPath = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignmentsPath,
    JSON.stringify({ schema: "aios.assignments/v1", assignments }),
    "utf8",
  );
  return assignmentsPath;
}

async function writeAdoptablePlan(root) {
  const planDirectory = path.join(root, "plans", "adoptable-plan");
  await mkdir(planDirectory, { recursive: true });
  await writeFile(
    path.join(planDirectory, "PLAN.md"),
    progressDocument(
      {
        schema: "aios.plan/v1",
        id: "adoptable-plan",
        project: PROGRESS_PROJECT,
        profile: "software-feature",
        profile_reason: "The requested outcome is a focused software feature.",
      },
      `
# Adoptable plan

## Brief

Deliver a focused feature.

## Profile Application

The software-feature profile produces one independently verifiable outcome.

## Assumptions and Risks

The fixture has no external dependencies.

## Decomposition Rationale

One proposal is sufficient and fits one Worker session.

## Execution Order

1. P-01 delivers the feature.
`,
    ),
    "utf8",
  );
  await writeFile(
    path.join(planDirectory, "P-01.md"),
    progressDocument(
      progressTaskMetadata("P-01"),
      `
# Deliver the feature

## Objective

Deliver one focused outcome.

## Acceptance Criteria

- The outcome has observable verification.

## Constraints

- Keep the work within one session.

## Context

Generated for CLI regression testing.

## Attempts

_None yet._
`,
    ),
    "utf8",
  );
  return planDirectory;
}

function progressCli(root, ...args) {
  return executeFile(process.execPath, [cli, "progress", ...args], {
    cwd: root,
    windowsHide: true,
  });
}

test("existing run, dashboard, and adopt success/failure exit codes remain stable", async (t) => {
  const dashboardRoot = await createProgressRoot(t);
  await writeProgressTask(dashboardRoot, progressTaskMetadata("task-0001"));
  const dashboardOut = path.join(dashboardRoot, "operator-dashboard.html");
  const dashboard = await executeFile(
    process.execPath,
    [cli, "dashboard", "--root", dashboardRoot, "--out", dashboardOut],
    { cwd: dashboardRoot, windowsHide: true },
  );
  assert.equal(dashboard.stderr, "");
  assert.equal(path.resolve(dashboard.stdout.trim()), dashboardOut);
  assert.equal(existsSync(dashboardOut), true);

  const adoptRoot = await createProgressRoot(t);
  await writeAdoptablePlan(adoptRoot);
  const checked = await executeFile(
    process.execPath,
    [cli, "adopt", "plans/adoptable-plan", "--root", adoptRoot, "--check"],
    { cwd: adoptRoot, windowsHide: true },
  );
  assert.deepEqual(JSON.parse(checked.stdout), {
    kind: "checked",
    plan: "adoptable-plan",
    profile: "software-feature",
    proposals: ["P-01"],
  });
  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "adopt", "plans/missing", "--root", adoptRoot],
      { cwd: adoptRoot, windowsHide: true },
    ),
    (error) => error.code === 1 && /unable to read plan directory/i.test(error.stderr),
  );

  const haltedRoot = await createProgressRoot(t);
  await writeProgressTask(haltedRoot, progressTaskMetadata("task-0001"));
  const haltedAssignments = await writeProgressAssignments(haltedRoot, {
    implementer: [process.execPath, fixture, "nonzero"],
  });
  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "run", "task-0001", "--root", haltedRoot, "--assignments", haltedAssignments],
      { cwd: haltedRoot, windowsHide: true },
    ),
    (error) => error.code === 1 && JSON.parse(error.stdout).kind === "halted",
  );

  const blockedRoot = await createProgressRoot(t);
  await seedProgressReview(blockedRoot, {
    id: "review-0001",
    attempt: 2,
    verdict: "changes_requested",
    task: "task-0001",
  });
  await writeProgressTask(
    blockedRoot,
    progressTaskMetadata("task-0001", {
      state: "blocked",
      retry: { count: 1, limit: 1 },
      last_review: "review-0001",
    }),
    2,
  );
  const blockedAssignments = await writeProgressAssignments(blockedRoot, {});
  await assert.rejects(
    executeFile(
      process.execPath,
      [cli, "run", "task-0001", "--root", blockedRoot, "--assignments", blockedAssignments],
      { cwd: blockedRoot, windowsHide: true },
    ),
    (error) => error.code === 2 && JSON.parse(error.stdout).kind === "blocked",
  );
});

test("--help documents progress alongside run, dashboard, and adopt", async () => {
  const { stdout } = await executeFile(process.execPath, [cli, "--help"], {
    windowsHide: true,
  });
  assert.match(stdout, /aios run <task-id>/);
  assert.match(stdout, /aios progress <plan-dir>/);
  assert.match(stdout, /aios dashboard/);
  assert.match(stdout, /aios adopt <plan-dir>/);
  assert.match(stdout, /run: 0 done, 1 halted, 2 blocked, 64 usage error, 75 waiting\./);
  assert.match(stdout, /progress: 0 plan complete, 3 awaiting approval, 4 blocked,/);
  assert.match(stdout, /5 capacity wait, 6 cancelled, 7 halted, 64 usage error\./);
});

test("progress usage and validation errors exit 64", async (t) => {
  const root = await createProgressRoot(t);
  const cases = [
    [["progress"], /Usage:/],
    [["progress", "--root", root], /Usage:/],
    [["progress", "plans/demo-plan", "--bogus", "x"], /Unknown option --bogus/],
    [["progress", "plans/demo-plan", "--timeout-ms", "nope"], /--timeout-ms must be a positive integer/],
    [["progress", "plans/demo-plan", "--max-capacity-wait-ms", "0"], /--max-capacity-wait-ms must be a positive integer/],
    [["progress", "plans/demo-plan", "--max-capacity-pauses", "-1"], /--max-capacity-pauses must be a positive integer/],
    [["progress", "plans/demo-plan", "--root"], /Missing value for --root/],
  ];
  for (const [args, expected] of cases) {
    await assert.rejects(
      executeFile(process.execPath, [cli, ...args], { cwd: root, windowsHide: true }),
      (error) => error.code === 64 && expected.test(error.stderr),
      `expected exit 64 for: ${args.join(" ")}`,
    );
  }
});

test("run parsing regressions: shared option validation still exits 64 with run's messages", async () => {
  const cases = [
    [["run", "task-9001", "--bogus", "x"], /Unknown option --bogus/],
    [["run", "task-9001", "--timeout-ms", "0"], /--timeout-ms must be a positive integer/],
    [["run", "task-9001", "--max-capacity-wait-ms", "nope"], /--max-capacity-wait-ms must be a positive integer/],
    [["run", "task-9001", "--max-capacity-pauses", "1.5"], /--max-capacity-pauses must be a positive integer/],
    [["run", "task-9001", "--assignments"], /Missing value for --assignments/],
    [["dashboard", "--bogus", "x"], /Unknown option --bogus/],
    [["adopt"], /Usage:/],
  ];
  for (const [args, expected] of cases) {
    await assert.rejects(
      executeFile(process.execPath, [cli, ...args], { windowsHide: true }),
      (error) => error.code === 64 && expected.test(error.stderr),
      `expected exit 64 for: ${args.join(" ")}`,
    );
  }
});

test("progress completes multiple Tasks in order from one invocation", async (t) => {
  const root = await createProgressRoot(t);
  await writeProgressTask(root, progressTaskMetadata("task-0001"));
  await writeProgressTask(root, progressTaskMetadata("task-0002"));
  await writeProgressPlan(root, { items: ["task-0001", "task-0002"] });
  await writeProgressAssignments(root, {
    implementer: [process.execPath, fixture, "auto-loop"],
    reviewer: [process.execPath, fixture, "auto-loop"],
  });

  // cwd differs from --root to prove <plan-dir> resolves against --root.
  const { stdout, stderr } = await executeFile(
    process.execPath,
    [cli, "progress", "plans/demo-plan", "--root", root],
    { cwd: projectRoot, windowsHide: true },
  );

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    plan: "demo-plan",
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

test("progress stops awaiting approval with exit 3 and re-invocation is idempotent", async (t) => {
  const root = await createProgressRoot(t);
  await seedProgressReview(root, {
    id: "review-0001",
    attempt: 1,
    verdict: "pass",
    task: "task-0001",
  });
  await writeProgressTask(
    root,
    progressTaskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await seedProgressReview(root, {
    id: "review-0002",
    attempt: 1,
    verdict: "pass",
    task: "task-0002",
  });
  await writeProgressTask(
    root,
    progressTaskMetadata("task-0002", {
      state: "approval",
      approval: "required",
      last_review: "review-0002",
    }),
    1,
  );
  await writeProgressPlan(root, { items: ["task-0001", "task-0002"] });
  await writeProgressAssignments(root, {
    approver: [process.execPath, approverWorker],
  });
  const taskPaths = [
    path.join(root, ".aios", "tasks", "task-0001.md"),
    path.join(root, ".aios", "tasks", "task-0002.md"),
  ];
  const before = await Promise.all(taskPaths.map((p) => readFile(p, "utf8")));

  let first;
  let second;
  try {
    await progressCli(root, "plans/demo-plan", "--root", root);
  } catch (error) {
    first = error;
  }
  try {
    await progressCli(root, "plans/demo-plan", "--root", root);
  } catch (error) {
    second = error;
  }

  assert.equal(first.code, 3);
  assert.equal(second.code, 3);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.plan, "demo-plan");
  assert.deepEqual(report.completed, ["task-0001"]);
  assert.equal(report.complete, false);
  assert.equal(report.task, "task-0002");
  assert.equal(report.stop_reason, "awaiting_approval");
  assert.equal(
    report.action,
    `Create ${path.join(root, ".aios", "approvals", "task-0002")} containing exactly ` +
      `"approved" or "rejected", then rerun progression.`,
  );
  const after = await Promise.all(taskPaths.map((p) => readFile(p, "utf8")));
  assert.deepEqual(after, before);
});

test("progress exits 4 on a blocked Task, for both rejection and retry exhaustion", async (t) => {
  const rejectedRoot = await createProgressRoot(t);
  await seedProgressReview(rejectedRoot, {
    id: "review-0001",
    attempt: 1,
    verdict: "pass",
    task: "task-0001",
  });
  await writeProgressTask(
    rejectedRoot,
    progressTaskMetadata("task-0001", {
      state: "blocked",
      approval: "rejected",
      last_review: "review-0001",
    }),
    1,
  );
  // An absolute <plan-dir> is used as-is, matching adopt's resolution rule.
  const rejectedPlan = await writeProgressPlan(rejectedRoot, { items: ["task-0001"] });
  await writeProgressAssignments(rejectedRoot, {});

  await assert.rejects(
    progressCli(rejectedRoot, rejectedPlan, "--root", rejectedRoot),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 4 &&
        report.stop_reason === "blocked_rejected" &&
        report.task === "task-0001" &&
        report.complete === false
      );
    },
  );

  const exhaustedRoot = await createProgressRoot(t);
  await seedProgressReview(exhaustedRoot, {
    id: "review-0002",
    attempt: 2,
    verdict: "changes_requested",
    task: "task-0001",
  });
  await writeProgressTask(
    exhaustedRoot,
    progressTaskMetadata("task-0001", {
      state: "blocked",
      retry: { count: 1, limit: 1 },
      last_review: "review-0002",
    }),
    2,
  );
  await writeProgressPlan(exhaustedRoot, { items: ["task-0001"] });
  await writeProgressAssignments(exhaustedRoot, {});

  await assert.rejects(
    progressCli(exhaustedRoot, "plans/demo-plan", "--root", exhaustedRoot),
    (error) =>
      error.code === 4 &&
      JSON.parse(error.stdout).stop_reason === "blocked_retry_exhausted",
  );
});

test("progress exits 5 when a Worker defers on capacity without --wait-for-capacity", async (t) => {
  const root = await createProgressRoot(t);
  await writeProgressTask(root, progressTaskMetadata("task-0001"));
  await writeProgressPlan(root, { items: ["task-0001"] });
  await writeProgressAssignments(root, {
    implementer: [process.execPath, fixture, "deferred"],
  });

  await assert.rejects(
    progressCli(root, "plans/demo-plan", "--root", root),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 5 &&
        report.stop_reason === "capacity_wait" &&
        report.task === "task-0001" &&
        /rerun progression at or after that time/.test(report.action)
      );
    },
  );
  const task = await new TaskStore(root).loadTask("task-0001");
  assert.equal(task.metadata.state, "implement");
});

test("progress passes capacity wait options through to the underlying engine runs", async (t) => {
  const root = await createProgressRoot(t);
  await writeProgressTask(root, progressTaskMetadata("task-0001"));
  await writeProgressPlan(root, { items: ["task-0001"] });
  const marker = path.join(root, "capacity-marker");
  await writeProgressAssignments(root, {
    implementer: [process.execPath, fixture, "capacity-loop", marker],
    reviewer: [process.execPath, fixture, "capacity-loop", marker],
  });

  const { stdout } = await progressCli(
    root,
    "plans/demo-plan",
    "--root",
    root,
    "--wait-for-capacity",
    "--max-capacity-wait-ms",
    "1000",
    "--max-capacity-pauses",
    "2",
  );

  const report = JSON.parse(stdout);
  assert.equal(report.stop_reason, "plan_complete");
  assert.deepEqual(report.completed, ["task-0001"]);
  const ledger = JSON.parse(
    await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
  );
  assert.deepEqual(
    ledger.sessions.map((session) => [session.role, session.invocations]),
    [
      ["implementer", 2],
      ["reviewer", 2],
    ],
  );
});

test("progress exits 7 on a Worker failure and on an unadopted plan", async (t) => {
  const failureRoot = await createProgressRoot(t);
  await writeProgressTask(failureRoot, progressTaskMetadata("task-0001"));
  await writeProgressPlan(failureRoot, { items: ["task-0001"] });
  await writeProgressAssignments(failureRoot, {
    implementer: [process.execPath, fixture, "nonzero"],
  });

  await assert.rejects(
    progressCli(failureRoot, "plans/demo-plan", "--root", failureRoot),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 7 &&
        report.stop_reason === "worker_failure" &&
        report.task === "task-0001"
      );
    },
  );

  const placeholderRoot = await createProgressRoot(t);
  await writeProgressPlan(placeholderRoot, {
    items: ["task-0001"],
    placeholders: true,
  });
  await writeProgressAssignments(placeholderRoot, {});

  await assert.rejects(
    progressCli(placeholderRoot, "plans/demo-plan", "--root", placeholderRoot),
    (error) => {
      const report = JSON.parse(error.stdout);
      return (
        error.code === 7 &&
        report.stop_reason === "invalid_document" &&
        report.task === null &&
        /adopt the plan before progressing it/.test(report.action)
      );
    },
  );
});

test("a termination signal cancels progression mid-run with exit 6 and no new Task started", async (t) => {
  const root = await createProgressRoot(t);
  await seedProgressReview(root, {
    id: "review-0001",
    attempt: 1,
    verdict: "pass",
    task: "task-0001",
  });
  await writeProgressTask(
    root,
    progressTaskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await writeProgressTask(root, progressTaskMetadata("task-0002"));
  await writeProgressPlan(root, { items: ["task-0001", "task-0002"] });
  const marker = path.join(root, "worker-started");
  const hangScript = path.join(root, "hang-worker.cjs");
  await writeFile(
    hangScript,
    'require("node:fs").writeFileSync(process.argv[2], "running");\nsetInterval(() => {}, 1000);\n',
    "utf8",
  );
  const assignmentsPath = await writeProgressAssignments(root, {
    implementer: [process.execPath, hangScript, marker],
  });
  const taskPath = path.join(root, ".aios", "tasks", "task-0002.md");
  const before = await readFile(taskPath, "utf8");

  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  let code;
  try {
    const pending = main([
      "progress",
      "plans/demo-plan",
      "--root",
      root,
      "--assignments",
      assignmentsPath,
    ]);
    for (let waited = 0; !existsSync(marker); waited += 1) {
      assert.ok(waited < 400, "the hanging Worker never started");
      await delay(25);
    }
    process.emit("SIGTERM");
    code = await pending;
  } finally {
    console.log = originalLog;
  }

  assert.equal(code, 6);
  assert.equal(logs.length, 1);
  const report = JSON.parse(logs[0]);
  assert.equal(report.stop_reason, "cancelled");
  assert.deepEqual(report.completed, ["task-0001"]);
  assert.equal(report.task, "task-0002");
  assert.equal(report.complete, false);
  assert.match(report.action, /rerun progression to continue/);
  assert.equal(await readFile(taskPath, "utf8"), before);
  assert.equal(process.listenerCount("SIGTERM"), 0);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

test("an already-cancelled CLI progression stops at the Task boundary without dispatch", async (t) => {
  const root = await createProgressRoot(t);
  await seedProgressReview(root, {
    id: "review-0001",
    attempt: 1,
    verdict: "pass",
    task: "task-0001",
  });
  await writeProgressTask(
    root,
    progressTaskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await writeProgressTask(root, progressTaskMetadata("task-0002"));
  await writeProgressPlan(root, { items: ["task-0001", "task-0002"] });
  const marker = path.join(root, "unexpected-worker-start");
  const markerWorker = path.join(root, "marker-worker.cjs");
  await writeFile(
    markerWorker,
    'require("node:fs").writeFileSync(process.argv[2], "started");\n',
    "utf8",
  );
  const assignmentsPath = await writeProgressAssignments(root, {
    implementer: [process.execPath, markerWorker, marker],
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  let code;
  try {
    const pending = main([
      "progress",
      "plans/demo-plan",
      "--root",
      root,
      "--assignments",
      assignmentsPath,
    ]);
    process.emit("SIGTERM");
    code = await pending;
  } finally {
    console.log = originalLog;
  }

  assert.equal(code, 6);
  assert.deepEqual(JSON.parse(logs[0]), {
    plan: "demo-plan",
    completed: ["task-0001"],
    complete: false,
    task: "task-0002",
    stop_reason: "cancelled",
    action: "The run was cancelled before Task task-0002 finished; rerun progression to continue.",
  });
  assert.equal(existsSync(marker), false);
  assert.equal(process.listenerCount("SIGTERM"), 0);
  assert.equal(process.listenerCount("SIGINT"), 0);
});
