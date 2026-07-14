import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { roleForState } from "../src/contracts.js";
import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import {
  PlanOrderError,
  readPlanOrder,
  runProgression,
  selectNextTask,
  STOP_REASONS,
} from "../src/progression.js";
import { StaticAssignmentResolver } from "../src/workers.js";
import { readDecision } from "../workers/human-approver.mjs";

const PROJECT = "test-project";

function document(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function taskMetadata(id, overrides = {}) {
  const retry = overrides.retry ?? { count: 0, limit: 2 };
  return {
    schema: "aios.task/v1",
    id,
    project: PROJECT,
    title: `Exercise ${id}`,
    state: "implement",
    retry,
    approval: "not_required",
    last_review: null,
    ...overrides,
    retry,
  };
}

function taskBody(attemptCount = 0) {
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

async function createRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-progression-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  return root;
}

async function writeTaskFile(root, metadata, attemptCount = 0) {
  const filePath = path.join(root, ".aios", "tasks", `${metadata.id}.md`);
  await writeFile(filePath, document(metadata, taskBody(attemptCount)), "utf8");
  return filePath;
}

async function seedReview(root, { id, attempt, verdict, task, project = PROJECT }) {
  const metadata = { schema: "aios.review/v1", id, project, task, attempt, verdict };
  const body = `\n# Review of ${task}, Attempt ${attempt}\n\n## Findings\n\nSeeded ${verdict}.\n`;
  await writeFile(
    path.join(root, ".aios", "reviews", `${id}.md`),
    document(metadata, body),
    "utf8",
  );
}

function planDirectory(root, planId) {
  return path.join(root, "plans", planId);
}

async function writePlan(
  root,
  { id = "demo-plan", project = PROJECT, items, placeholders = false } = {},
) {
  const dir = planDirectory(root, id);
  await mkdir(dir, { recursive: true });
  const metadata = {
    schema: "aios.plan/v1",
    id,
    project,
    profile: "software-feature",
    profile_reason: "Testing progression.",
  };
  const listed = placeholders
    ? items.map((_, index) => `P-${String(index + 1).padStart(2, "0")}`)
    : items;
  const list = listed.map((entry, index) => `${index + 1}. ${entry} advances step ${index + 1}.`).join("\n");
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
  await writeFile(path.join(dir, "PLAN.md"), document(metadata, body), "utf8");
  return dir;
}

class AutoWorker {
  constructor({ reviewVerdict = "pass", decision = "approved" } = {}) {
    this.reviewVerdict = reviewVerdict;
    this.decision = decision;
    this.calls = [];
  }

  async execute(task) {
    const role = roleForState(task.metadata.state);
    this.calls.push({ task: task.metadata.id, role });
    const base = { schema: "aios.result/v1", task: task.metadata.id, role, status: "success" };
    if (role === "implementer") {
      return {
        ...base,
        payload: {
          summary: `Implemented ${task.metadata.id}.`,
          verification: `Verified ${task.metadata.id}.`,
        },
      };
    }
    if (role === "reviewer") {
      return {
        ...base,
        payload: { verdict: this.reviewVerdict, findings: `${this.reviewVerdict} findings.` },
      };
    }
    return { ...base, payload: { decision: this.decision } };
  }
}

class AlwaysFail {
  constructor(reason) {
    this.reason = reason;
    this.calls = 0;
  }

  async execute(task) {
    this.calls += 1;
    const role = roleForState(task.metadata.state);
    return {
      schema: "aios.result/v1",
      task: task.metadata.id,
      role,
      status: "failure",
      payload: { reason: this.reason },
    };
  }
}

// Mirrors workers/human-approver.mjs exactly: reads the real decision file
// under `.aios/approvals/<task-id>` and turns it into a Result, so this
// fixture faithfully reaches the approval_gate category through the same
// missing/invalid-decision-file path the shipped Worker uses, rather than
// masking it behind an unrelated Assignment-resolution failure.
class HumanApprover {
  constructor(root) {
    this.root = root;
    this.calls = [];
  }

  async execute(task) {
    this.calls.push(task.metadata.id);
    const { status, payload } = await readDecision(task.metadata.id, this.root);
    return { schema: "aios.result/v1", task: task.metadata.id, role: "approver", status, payload };
  }
}

class FailingApprover {
  constructor(reason) {
    this.reason = reason;
    this.calls = 0;
  }

  async execute() {
    this.calls += 1;
    throw new Error(this.reason);
  }
}

class MutatingWorker {
  async execute(task) {
    await writeFile(task.path, `${task.raw}\n`, "utf8");
    return {
      schema: "aios.result/v1",
      task: task.metadata.id,
      role: "implementer",
      status: "success",
      payload: { summary: "A conflicting attempt.", verification: "Verified." },
    };
  }
}

function makeEngine(root, assignments, extra = {}) {
  return new LoopEngine({ root, assignments: new StaticAssignmentResolver(assignments), ...extra });
}

test("readPlanOrder derives Task order from Execution Order document order, not numeric order", async (t) => {
  const root = await createRoot(t);
  const ids = ["task-0050", "task-0010", "task-0030"];
  for (const id of ids) {
    await writeTaskFile(root, taskMetadata(id));
  }
  const dir = await writePlan(root, { items: ids });

  const { order, plan } = await readPlanOrder({
    root,
    planDirectory: dir,
    store: new TaskStore(root),
  });

  assert.deepEqual(order, ids);
  assert.equal(plan, "demo-plan");
});

test("readPlanOrder rejects a not-yet-adopted plan with a named error", async (t) => {
  const root = await createRoot(t);
  const dir = await writePlan(root, { items: ["task-0001", "task-0002"], placeholders: true });

  await assert.rejects(
    () => readPlanOrder({ root, planDirectory: dir, store: new TaskStore(root) }),
    PlanOrderError,
  );
});

test("readPlanOrder rejects a Task/plan project mismatch without a partial order", async (t) => {
  const root = await createRoot(t);
  await writeTaskFile(root, taskMetadata("task-0001"));
  await writeTaskFile(root, taskMetadata("task-0002", { project: "other-project" }));
  const dir = await writePlan(root, { items: ["task-0001", "task-0002"] });

  await assert.rejects(
    () => readPlanOrder({ root, planDirectory: dir, store: new TaskStore(root) }),
    PlanOrderError,
  );
});

test("selectNextTask skips a done prefix and reports plan completion when all Tasks are done", async (t) => {
  const root = await createRoot(t);
  const store = new TaskStore(root);
  await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
  await writeTaskFile(
    root,
    taskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await writeTaskFile(root, taskMetadata("task-0002"));

  const selection = await selectNextTask({ store, order: ["task-0001", "task-0002"] });
  assert.deepEqual(selection.completed, ["task-0001"]);
  assert.equal(selection.next, "task-0002");

  await seedReview(root, { id: "review-0002", attempt: 1, verdict: "pass", task: "task-0002" });
  await writeTaskFile(
    root,
    taskMetadata("task-0002", { state: "done", last_review: "review-0002" }),
    1,
  );
  const complete = await selectNextTask({ store, order: ["task-0001", "task-0002"] });
  assert.deepEqual(complete.completed, ["task-0001", "task-0002"]);
  assert.equal(complete.next, null);
});

test("runProgression advances multiple Tasks in order and skips an already-done prefix", async (t) => {
  const root = await createRoot(t);
  await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
  await writeTaskFile(
    root,
    taskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await writeTaskFile(root, taskMetadata("task-0002"));
  await writeTaskFile(root, taskMetadata("task-0003"));
  const dir = await writePlan(root, { items: ["task-0001", "task-0002", "task-0003"] });
  const auto = new AutoWorker();
  const engine = makeEngine(root, { implementer: auto, reviewer: auto });

  const outcome = await runProgression({ root, planDirectory: dir, engine });

  assert.equal(outcome.stopReason, STOP_REASONS.PLAN_COMPLETE);
  assert.equal(outcome.task, null);
  assert.deepEqual(outcome.completed, ["task-0001", "task-0002", "task-0003"]);
  assert.deepEqual(
    auto.calls.map((call) => call.task),
    ["task-0002", "task-0002", "task-0003", "task-0003"],
  );
});

test("runProgression skips an already-done Task interleaved after the initial unfinished Task", async (t) => {
  const root = await createRoot(t);
  await writeTaskFile(root, taskMetadata("task-0001"));
  await seedReview(root, { id: "review-0002", attempt: 1, verdict: "pass", task: "task-0002" });
  await writeTaskFile(
    root,
    taskMetadata("task-0002", { state: "done", last_review: "review-0002" }),
    1,
  );
  await writeTaskFile(root, taskMetadata("task-0003"));
  const dir = await writePlan(root, { items: ["task-0001", "task-0002", "task-0003"] });
  const auto = new AutoWorker();
  const engine = makeEngine(root, { implementer: auto, reviewer: auto });
  const runSpy = [];
  const originalRun = engine.run.bind(engine);
  engine.run = async (taskId, options) => {
    runSpy.push(taskId);
    return originalRun(taskId, options);
  };

  const outcome = await runProgression({ root, planDirectory: dir, engine });

  assert.equal(outcome.stopReason, STOP_REASONS.PLAN_COMPLETE);
  assert.deepEqual(outcome.completed, ["task-0001", "task-0002", "task-0003"]);
  assert.deepEqual(runSpy, ["task-0001", "task-0003"]);
});

test("runProgression never skips an undecidable Task to reach a later Task", async (t) => {
  const root = await createRoot(t);
  await seedReview(root, {
    id: "review-0002",
    attempt: 2,
    verdict: "changes_requested",
    task: "task-0001",
  });
  await writeTaskFile(
    root,
    taskMetadata("task-0001", {
      state: "blocked",
      retry: { count: 1, limit: 1 },
      last_review: "review-0002",
    }),
    2,
  );
  await writeTaskFile(root, taskMetadata("task-0002"));
  const dir = await writePlan(root, { items: ["task-0001", "task-0002"] });
  const auto = new AutoWorker();
  const engine = makeEngine(root, { implementer: auto, reviewer: auto });

  const outcome = await runProgression({ root, planDirectory: dir, engine });

  assert.equal(outcome.stopReason, STOP_REASONS.BLOCKED_RETRY_EXHAUSTED);
  assert.equal(outcome.task, "task-0001");
  assert.deepEqual(outcome.completed, []);
  assert.deepEqual(auto.calls, []);
});

test("every stop reason is reached through a fixture repository state", async (t) => {
  await t.test("awaiting approval", async (st) => {
    const root = await createRoot(st);
    await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
    await writeTaskFile(
      root,
      taskMetadata("task-0001", {
        state: "approval",
        approval: "required",
        last_review: "review-0001",
      }),
      1,
    );
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, { approver: new HumanApprover(root) });

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.AWAITING_APPROVAL);
    assert.equal(outcome.task, "task-0001");
    assert.match(outcome.action, /\.aios[\\/]approvals[\\/]task-0001/);
  });

  await t.test("an approver Assignment/execution failure is not an approval gate", async (st) => {
    const root = await createRoot(st);
    await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
    await writeTaskFile(
      root,
      taskMetadata("task-0001", {
        state: "approval",
        approval: "required",
        last_review: "review-0001",
      }),
      1,
    );
    const dir = await writePlan(root, { items: ["task-0001"] });

    const noAssignment = await runProgression({
      root,
      planDirectory: dir,
      engine: makeEngine(root, {}),
    });
    assert.equal(noAssignment.stopReason, STOP_REASONS.WORKER_FAILURE);
    assert.notEqual(noAssignment.stopReason, STOP_REASONS.AWAITING_APPROVAL);

    const executionFailure = await runProgression({
      root,
      planDirectory: dir,
      engine: makeEngine(root, { approver: new FailingApprover("approver Worker crashed") }),
    });
    assert.equal(executionFailure.stopReason, STOP_REASONS.WORKER_FAILURE);
    assert.match(executionFailure.action, /approver Worker crashed/);
  });

  await t.test("blocked (rejected)", async (st) => {
    const root = await createRoot(st);
    await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
    await writeTaskFile(
      root,
      taskMetadata("task-0001", {
        state: "blocked",
        approval: "rejected",
        last_review: "review-0001",
      }),
      1,
    );
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, {});

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.BLOCKED_REJECTED);
    assert.equal(outcome.task, "task-0001");
  });

  await t.test("blocked (retry limit exhausted)", async (st) => {
    const root = await createRoot(st);
    await seedReview(root, {
      id: "review-0002",
      attempt: 2,
      verdict: "changes_requested",
      task: "task-0001",
    });
    await writeTaskFile(
      root,
      taskMetadata("task-0001", {
        state: "blocked",
        retry: { count: 1, limit: 1 },
        last_review: "review-0002",
      }),
      2,
    );
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, {});

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.BLOCKED_RETRY_EXHAUSTED);
  });

  await t.test("Worker failure", async (st) => {
    const root = await createRoot(st);
    await writeTaskFile(root, taskMetadata("task-0001"));
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, { implementer: new AlwaysFail("Worker could not complete.") });

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.WORKER_FAILURE);
    assert.match(outcome.action, /could not complete/);
  });

  await t.test("invalid document", async (st) => {
    const root = await createRoot(st);
    await writeTaskFile(
      root,
      taskMetadata("task-0001", { retry: { count: 1, limit: 2 }, last_review: "review-9999" }),
      1,
    );
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, { implementer: new AutoWorker() });

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.INVALID_DOCUMENT);
  });

  await t.test("capacity wait", async (st) => {
    const root = await createRoot(st);
    await writeTaskFile(root, taskMetadata("task-0001"));
    const dir = await writePlan(root, { items: ["task-0001"] });
    const retryAt = new Date(Date.parse("2026-07-14T00:00:05.000Z")).toISOString();
    const worker = {
      async execute() {
        const { CapacityDeferredError } = await import("../src/workers.js");
        throw new CapacityDeferredError("Worker capacity is unavailable", {
          retryAt,
          continuation: "continue-1",
          sessionId: "session-a",
        });
      },
    };
    const engine = makeEngine(root, { implementer: worker }, {
      clock: () => Date.parse("2026-07-14T00:00:00.000Z"),
    });

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.CAPACITY_WAIT);
    assert.match(outcome.action, /2026-07-14T00:00:05/);
  });

  await t.test("cancelled", async (st) => {
    const root = await createRoot(st);
    await writeTaskFile(root, taskMetadata("task-0001"));
    const dir = await writePlan(root, { items: ["task-0001"] });
    const controller = new AbortController();
    const worker = {
      async execute() {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const engine = makeEngine(root, { implementer: worker });

    const outcome = await runProgression({
      root,
      planDirectory: dir,
      engine,
      runOptions: { signal: controller.signal },
    });
    assert.equal(outcome.stopReason, STOP_REASONS.CANCELLED);
  });

  await t.test("repository mutation conflict", async (st) => {
    const root = await createRoot(st);
    await writeTaskFile(root, taskMetadata("task-0001"));
    const dir = await writePlan(root, { items: ["task-0001"] });
    const engine = makeEngine(root, { implementer: new MutatingWorker() });

    const outcome = await runProgression({ root, planDirectory: dir, engine });
    assert.equal(outcome.stopReason, STOP_REASONS.CONFLICT);
  });
});

test("a second, immediate invocation reproduces the identical stop outcome idempotently, with a done prefix never re-invoked", async (t) => {
  const root = await createRoot(t);
  await seedReview(root, { id: "review-0001", attempt: 1, verdict: "pass", task: "task-0001" });
  await writeTaskFile(
    root,
    taskMetadata("task-0001", { state: "done", last_review: "review-0001" }),
    1,
  );
  await seedReview(root, { id: "review-0002", attempt: 1, verdict: "pass", task: "task-0002" });
  await writeTaskFile(
    root,
    taskMetadata("task-0002", {
      state: "approval",
      approval: "required",
      last_review: "review-0002",
    }),
    1,
  );
  const dir = await writePlan(root, { items: ["task-0001", "task-0002"] });
  const task1Path = path.join(root, ".aios", "tasks", "task-0001.md");
  const task2Path = path.join(root, ".aios", "tasks", "task-0002.md");
  const before1 = await readFile(task1Path, "utf8");
  const before2 = await readFile(task2Path, "utf8");

  const approverOne = new HumanApprover(root);
  const first = await runProgression({
    root,
    planDirectory: dir,
    engine: makeEngine(root, { approver: approverOne }),
  });
  const approverTwo = new HumanApprover(root);
  const second = await runProgression({
    root,
    planDirectory: dir,
    engine: makeEngine(root, { approver: approverTwo }),
  });

  assert.deepEqual(first, second);
  assert.equal(first.stopReason, STOP_REASONS.AWAITING_APPROVAL);
  assert.equal(first.task, "task-0002");
  assert.deepEqual(first.completed, ["task-0001"]);
  assert.deepEqual(approverOne.calls, ["task-0002"]);
  assert.deepEqual(approverTwo.calls, ["task-0002"]);
  assert.equal(await readFile(task1Path, "utf8"), before1);
  assert.equal(await readFile(task2Path, "utf8"), before2);
});
