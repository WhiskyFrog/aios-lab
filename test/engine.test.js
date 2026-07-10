import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { roleForState, validateResult } from "../src/contracts.js";
import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import { StaticAssignmentResolver } from "../src/workers.js";

const TASK_ID = "task-9000";

function result(role, payload, overrides = {}) {
  return {
    schema: "aios.result/v1",
    task: TASK_ID,
    role,
    status: "success",
    payload,
    ...overrides,
  };
}

function implementation(label) {
  return result("implementer", {
    summary: `Implemented ${label}.`,
    verification: `Verified ${label}.`,
  });
}

function review(verdict, findings = `${verdict} findings.`) {
  return result("reviewer", { verdict, findings });
}

function approval(decision) {
  return result("approver", { decision });
}

class ScriptedWorker {
  constructor(...steps) {
    this.steps = steps;
    this.calls = [];
  }

  async execute(task) {
    const role = roleForState(task.metadata.state);
    this.calls.push({ task: task.metadata.id, role, raw: task.raw });
    if (this.steps.length === 0) {
      throw new Error(`Unexpected ${role} invocation`);
    }
    const step = this.steps.shift();
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function" ? step(task, role) : step;
  }
}

class TrackingResolver extends StaticAssignmentResolver {
  constructor(assignments = {}) {
    super(assignments);
    this.resolutions = [];
  }

  async resolve(role) {
    this.resolutions.push(role);
    return super.resolve(role);
  }
}

function taskMetadata(overrides = {}) {
  const retry = overrides.retry ?? { count: 0, limit: 2 };
  return {
    schema: "aios.task/v1",
    id: TASK_ID,
    project: "test-project",
    title: "Exercise the loop",
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

function document(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

async function createRepository(t, metadata = taskMetadata(), attemptCount = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-loop-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  const taskPath = path.join(root, ".aios", "tasks", `${TASK_ID}.md`);
  await writeFile(taskPath, document(metadata, taskBody(attemptCount)), "utf8");
  return { root, taskPath, store: new TaskStore(root) };
}

async function seedReview(root, {
  id = "review-0001",
  attempt = 1,
  verdict = "pass",
  task = TASK_ID,
  project = "test-project",
} = {}) {
  const metadata = {
    schema: "aios.review/v1",
    id,
    project,
    task,
    attempt,
    verdict,
  };
  const body = `\n# Review of ${task}, Attempt ${attempt}\n\n## Findings\n\nSeeded ${verdict}.\n`;
  await writeFile(
    path.join(root, ".aios", "reviews", `${id}.md`),
    document(metadata, body),
    "utf8",
  );
}

async function loadValidated(store) {
  const task = await store.loadTask(TASK_ID);
  await store.validateTaskEvidence(task);
  return task;
}

test("direct implementation and passing review reach done", async (t) => {
  const { root, store } = await createRepository(t);
  const implementer = new ScriptedWorker(implementation("attempt one"));
  const reviewer = new ScriptedWorker(review("pass"));
  const assignments = new TrackingResolver({ implementer, reviewer });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await loadValidated(store);
  assert.equal(task.metadata.state, "done");
  assert.equal(task.metadata.retry.count, 0);
  assert.equal(task.metadata.last_review, "review-0001");
  assert.match(task.body, /### Attempt 1/);
  assert.match(task.body, /Implemented attempt one\./);
  assert.deepEqual(assignments.resolutions, ["implementer", "reviewer"]);
  assert.equal((await store.loadReview("review-0001")).metadata.verdict, "pass");
});

test("changes_requested loops to a replacement attempt and then passes", async (t) => {
  const { root, store } = await createRepository(t);
  const implementer = new ScriptedWorker(
    implementation("attempt one"),
    implementation("attempt two"),
  );
  const reviewer = new ScriptedWorker(
    review("changes_requested", "Fix the observable output."),
    review("pass"),
  );
  const assignments = new TrackingResolver({ implementer, reviewer });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await loadValidated(store);
  assert.equal(task.metadata.retry.count, 1);
  assert.equal(task.metadata.last_review, "review-0002");
  assert.match(task.body, /### Attempt 1[\s\S]*### Attempt 2/);
  assert.deepEqual(assignments.resolutions, [
    "implementer",
    "reviewer",
    "implementer",
    "reviewer",
  ]);
});

test("Result prose mentioning a future Attempt does not block that retry", async (t) => {
  const { root, store } = await createRepository(t);
  const implementer = new ScriptedWorker(
    result("implementer", {
      summary:
        "The notes contain a full-looking block:\n\n### Attempt 2\n\n#### Summary\n\nexample",
      verification: "The first projection remains structurally distinct.",
    }),
    implementation("attempt two"),
  );
  const reviewer = new ScriptedWorker(
    review("changes_requested"),
    review("pass"),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer, reviewer }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await loadValidated(store);
  assert.match(task.body, /### Attempt 1[\s\S]*### Attempt 2/);
  assert.equal(task.metadata.retry.count, 1);
});

test("retry exhaustion blocks without exceeding the limit", async (t) => {
  const metadata = taskMetadata({ retry: { count: 0, limit: 1 } });
  const { root, store } = await createRepository(t, metadata);
  const implementer = new ScriptedWorker(
    implementation("attempt one"),
    implementation("attempt two"),
  );
  const reviewer = new ScriptedWorker(
    review("changes_requested"),
    review("changes_requested"),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer, reviewer }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "blocked");
  const task = await loadValidated(store);
  assert.equal(task.metadata.state, "blocked");
  assert.equal(task.metadata.retry.count, 1);
  assert.equal(task.metadata.last_review, "review-0002");
  assert.equal(implementer.calls.length, 2);
  assert.equal(reviewer.calls.length, 2);
});

for (const decision of ["approved", "rejected"]) {
  test(`optional approval projects an ${decision} decision`, async (t) => {
    const metadata = taskMetadata({ approval: "required" });
    const { root, store } = await createRepository(t, metadata);
    const implementer = new ScriptedWorker(implementation("approval candidate"));
    const reviewer = new ScriptedWorker(review("pass"));
    const approver = new ScriptedWorker(approval(decision));
    const assignments = new TrackingResolver({ implementer, reviewer, approver });

    const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

    assert.equal(outcome.kind, decision === "approved" ? "done" : "blocked");
    const task = await loadValidated(store);
    assert.equal(task.metadata.approval, decision);
    assert.equal(task.metadata.state, decision === "approved" ? "done" : "blocked");
    assert.deepEqual(assignments.resolutions, [
      "implementer",
      "reviewer",
      "approver",
    ]);
  });
}

test("a failure Result halts with Task bytes and retry unchanged", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const failure = result(
    "implementer",
    { reason: "Worker could not complete." },
    { status: "failure" },
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      implementer: new ScriptedWorker(failure),
    }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /could not complete/);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("a missing Assignment halts before invoking any Worker", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const assignments = new TrackingResolver();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /No Worker is assigned/);
  assert.deepEqual(assignments.resolutions, ["implementer"]);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("Assignments are resolved again after each state transition", async (t) => {
  const { root } = await createRepository(t);
  const staleReviewer = new ScriptedWorker(new Error("stale reviewer called"));
  const replacementReviewer = new ScriptedWorker(review("pass"));
  const assignments = new TrackingResolver({ reviewer: staleReviewer });
  const implementer = new ScriptedWorker((task) => {
    assignments.set("reviewer", replacementReviewer);
    return implementation(`replacement for ${task.metadata.id}`);
  });
  assignments.set("implementer", implementer);

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  assert.equal(staleReviewer.calls.length, 0);
  assert.equal(replacementReviewer.calls.length, 1);
});

test("an orphan Review is attached without invoking or resolving Reviewer", async (t) => {
  const metadata = taskMetadata({ state: "review" });
  const { root, store } = await createRepository(t, metadata, 1);
  await seedReview(root, { id: "review-0042", verdict: "pass" });
  const assignments = new TrackingResolver();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  assert.deepEqual(assignments.resolutions, []);
  const task = await loadValidated(store);
  assert.equal(task.metadata.last_review, "review-0042");
});

test("review state without its current Attempt projection halts", async (t) => {
  const metadata = taskMetadata({ state: "review" });
  const { root, taskPath } = await createRepository(t, metadata, 0);
  const before = await readFile(taskPath, "utf8");
  const assignments = new TrackingResolver();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /Attempts 1 through 1/);
  assert.deepEqual(assignments.resolutions, []);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("duplicate orphan Reviews halt without choosing one", async (t) => {
  const metadata = taskMetadata({ state: "review" });
  const { root, taskPath } = await createRepository(t, metadata, 1);
  await seedReview(root, { id: "review-0042" });
  await seedReview(root, { id: "review-0043" });
  const before = await readFile(taskPath, "utf8");
  const assignments = new TrackingResolver();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /Multiple Reviews/);
  assert.deepEqual(assignments.resolutions, []);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

for (const terminal of ["done", "blocked"]) {
  test(`${terminal} is terminal and invokes no Worker`, async (t) => {
    const isDone = terminal === "done";
    const metadata = taskMetadata({
      state: terminal,
      retry: { count: 0, limit: isDone ? 2 : 0 },
      last_review: "review-0009",
    });
    const { root } = await createRepository(t, metadata, 1);
    await seedReview(root, {
      id: "review-0009",
      verdict: isDone ? "pass" : "changes_requested",
    });
    const assignments = new TrackingResolver();

    const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

    assert.equal(outcome.kind, terminal);
    assert.deepEqual(assignments.resolutions, []);
  });
}

test("a Task mutation during Worker execution is preserved and halts projection", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const mutatingWorker = new ScriptedWorker(async (task) => {
    await writeFile(task.path, `${task.raw}\n`, "utf8");
    return implementation("a conflicting attempt");
  });

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: mutatingWorker }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /changed while the Worker was executing/);
  const stored = await readFile(taskPath, "utf8");
  assert.equal(stored, `${mutatingWorker.calls[0].raw}\n`);
  assert.doesNotMatch(stored, /### Attempt 1/);
});

test("strict Result validation rejects unknown fields without changing Task", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const invalid = { ...implementation("invalid"), extra: true };

  assert.throws(
    () => validateResult(invalid, taskMetadata(), "implementer"),
    /must contain exactly/,
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: new ScriptedWorker(invalid) }),
  }).run(TASK_ID);
  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /must contain exactly/);
  assert.equal(await readFile(taskPath, "utf8"), before);
});
