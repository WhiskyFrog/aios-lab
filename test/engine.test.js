import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { roleForState, validateResult } from "../src/contracts.js";
import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import {
  CapacityDeferredError,
  StaticAssignmentResolver,
} from "../src/workers.js";

const TASK_ID = "task-9000";
const CLOCK_START = Date.parse("2026-07-12T00:00:00.000Z");

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

class CapacityWorker {
  constructor(...steps) {
    this.steps = steps;
    this.calls = [];
  }

  async execute(task, { continuation = null } = {}) {
    const role = roleForState(task.metadata.state);
    this.calls.push({ task: task.metadata.id, role, continuation });
    if (this.steps.length === 0) {
      throw new Error(`Unexpected ${role} invocation`);
    }
    const step = this.steps.shift();
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function"
      ? step(task, role, continuation)
      : step;
  }
}

function deferred(now, delayMs, continuation, sessionId = "session-a") {
  return new CapacityDeferredError("Worker capacity is temporarily unavailable", {
    retryAt: new Date(now + delayMs).toISOString(),
    continuation,
    sessionId,
  });
}

function fakeTime(start = CLOCK_START) {
  let now = start;
  const sleeps = [];
  return {
    clock: () => now,
    sleeps,
    sleep: async (ms, { signal } = {}) => {
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      sleeps.push(ms);
      now += ms;
    },
  };
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

test("identical Implementer evidence halts without consuming another retry", async (t) => {
  const { root, store } = await createRepository(t);
  const unchanged = implementation("unchanged submission");
  const implementer = new ScriptedWorker(unchanged, structuredClone(unchanged));
  const reviewer = new ScriptedWorker(
    review("changes_requested", "Address the concrete review findings."),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer, reviewer }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.category, "worker_failure");
  assert.match(outcome.reason, /repeated the evidence from Attempt 1/);
  const haltedTask = await loadValidated(store);
  assert.equal(haltedTask.metadata.state, "implement");
  assert.equal(haltedTask.metadata.retry.count, 1);
  assert.equal(haltedTask.metadata.last_review, "review-0001");
  assert.match(haltedTask.body, /### Attempt 1/);
  assert.doesNotMatch(haltedTask.body, /### Attempt 2/);
  assert.equal(implementer.calls.length, 2);
  assert.equal(reviewer.calls.length, 1);
  assert.equal((await store.listReviews()).length, 1);

  const recovered = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      implementer: new ScriptedWorker(implementation("corrected submission")),
      reviewer: new ScriptedWorker(review("pass")),
    }),
  }).run(TASK_ID);
  assert.equal(recovered.kind, "done");
  const doneTask = await loadValidated(store);
  assert.equal(doneTask.metadata.retry.count, 1);
  assert.match(doneTask.body, /### Attempt 1[\s\S]*### Attempt 2/);
});

test("changing either evidence field preserves automatic retry", async (t) => {
  const { root, store } = await createRepository(t);
  const implementer = new ScriptedWorker(
    result("implementer", {
      summary: "Implemented the same scoped correction.",
      verification: "First verification evidence.",
    }),
    result("implementer", {
      summary: "Implemented the same scoped correction.",
      verification: "Replacement verification evidence.",
    }),
  );
  const reviewer = new ScriptedWorker(review("changes_requested"), review("pass"));

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer, reviewer }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await loadValidated(store);
  assert.equal(task.metadata.retry.count, 1);
  assert.match(task.body, /First verification evidence[\s\S]*Replacement verification evidence/);
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
  assert.equal(outcome.category, "worker_failure");
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("a missing Assignment halts before invoking any Worker", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const assignments = new TrackingResolver();

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.category, "worker_failure");
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

test("Role resolution receives an immutable backward-compatible dispatch context", async (t) => {
  const { root } = await createRepository(t);
  const contexts = [];
  class ContextResolver extends StaticAssignmentResolver {
    async resolve(role, context) {
      contexts.push(context);
      return super.resolve(role);
    }
  }
  const assignments = new ContextResolver({
    implementer: new ScriptedWorker(implementation("context")),
    reviewer: new ScriptedWorker(review("pass")),
  });

  const outcome = await new LoopEngine({ root, assignments }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  assert.equal(contexts.length, 2);
  assert.deepEqual(
    contexts.map(({ role, attempt, routingPolicyRevision }) => ({
      role,
      attempt,
      routingPolicyRevision,
    })),
    [
      { role: "implementer", attempt: 1, routingPolicyRevision: null },
      { role: "reviewer", attempt: 1, routingPolicyRevision: null },
    ],
  );
  for (const context of contexts) {
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.task), true);
    assert.equal(Object.isFrozen(context.reviews), true);
    assert.equal(Object.isFrozen(context.runOptions), true);
  }
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
  assert.equal(outcome.category, "invalid_document");
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
  assert.equal(outcome.category, "conflict");
  const stored = await readFile(taskPath, "utf8");
  assert.equal(stored, `${mutatingWorker.calls[0].raw}\n`);
  assert.doesNotMatch(stored, /### Attempt 1/);
});

test("an approver Result failure halts with the approval_gate category", async (t) => {
  const metadata = taskMetadata({
    state: "approval",
    approval: "required",
    last_review: "review-0042",
  });
  const { root } = await createRepository(t, metadata, 1);
  await seedReview(root, { id: "review-0042", verdict: "pass" });
  const approver = new ScriptedWorker(
    result(
      "approver",
      { reason: 'awaiting human decision: create .aios/approvals/task-9000 containing exactly "approved" or "rejected"' },
      { status: "failure" },
    ),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ approver }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.category, "approval_gate");
});

test("cancellation during active Worker execution halts with the cancelled category", async (t) => {
  const { root } = await createRepository(t);
  const controller = new AbortController();
  const worker = {
    async execute() {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  };

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: worker }),
  }).run(TASK_ID, { signal: controller.signal });

  assert.equal(outcome.kind, "halted");
  assert.equal(outcome.category, "cancelled");
});

test("a CRLF-materialized checkout keeps framed Attempts readable and finishes", async (t) => {
  const { root, taskPath, store } = await createRepository(t);
  const firstRun = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      implementer: new ScriptedWorker(
        result("implementer", {
          summary: "Line one.\r\nLine two.",
          verification: "Verified with CRLF payload endings.",
        }),
      ),
    }),
  }).run(TASK_ID);
  assert.equal(firstRun.kind, "halted");
  assert.match(firstRun.reason, /No Worker is assigned/);

  const materialized = (await readFile(taskPath, "utf8")).replace(
    /\r?\n/g,
    "\r\n",
  );
  await writeFile(taskPath, materialized, "utf8");

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      reviewer: new ScriptedWorker(review("pass")),
    }),
  }).run(TASK_ID);

  assert.equal(outcome.kind, "done");
  const task = await loadValidated(store);
  assert.equal(task.metadata.state, "done");
  assert.match(task.body, /Line one\./);
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

test("failure_kind is optional but closed to the recoverable Result vocabulary", () => {
  const metadata = taskMetadata();
  const base = {
    schema: "aios.result/v1",
    task: TASK_ID,
    role: "implementer",
    status: "failure",
  };
  assert.equal(
    validateResult(
      {
        ...base,
        payload: {
          reason: "objective checks failed",
          failure_kind: "verification_failed",
        },
      },
      metadata,
      "implementer",
    ).payload.failure_kind,
    "verification_failed",
  );
  assert.throws(
    () =>
      validateResult(
        {
          ...base,
          payload: { reason: "unknown", failure_kind: "provider_failure" },
        },
        metadata,
        "implementer",
      ),
    /unknown value/,
  );
});

test("a capacity deferral returns waiting without changing Task state or retry", async (t) => {
  const { root, taskPath, store } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const retryAt = new Date(CLOCK_START + 5_000).toISOString();
  const worker = new CapacityWorker(
    deferred(CLOCK_START, 5_000, "continue-implementer"),
  );
  let sleepCalls = 0;

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: worker }),
    clock: () => CLOCK_START,
    sleep: async () => {
      sleepCalls += 1;
    },
  }).run(TASK_ID);

  assert.equal(outcome.kind, "waiting");
  assert.equal(outcome.retryAt, retryAt);
  assert.match(outcome.reason, /capacity/i);
  assert.deepEqual(worker.calls.map((call) => call.continuation), [null]);
  assert.equal(sleepCalls, 0);
  assert.equal(await readFile(taskPath, "utf8"), before);
  const task = await loadValidated(store);
  assert.equal(task.metadata.state, "implement");
  assert.equal(task.metadata.retry.count, 0);
});

test("capacity wait resumes the same Worker with its continuation and completes", async (t) => {
  const { root, store } = await createRepository(t);
  const time = fakeTime();
  const implementer = new CapacityWorker(
    deferred(CLOCK_START, 2_500, "continue-1"),
    implementation("after refill"),
  );
  const reviewer = new ScriptedWorker(review("pass"));
  const assignments = new TrackingResolver({ implementer, reviewer });
  const sleep = async (ms, options) => {
    const waitingTask = await loadValidated(store);
    assert.equal(waitingTask.metadata.state, "implement");
    assert.equal(waitingTask.metadata.retry.count, 0);
    await time.sleep(ms, options);
  };

  const outcome = await new LoopEngine({
    root,
    assignments,
    clock: time.clock,
    sleep,
  }).run(TASK_ID, { waitForCapacity: true });

  assert.equal(outcome.kind, "done");
  assert.deepEqual(time.sleeps, [2_500]);
  assert.deepEqual(
    implementer.calls.map((call) => call.continuation),
    [null, "continue-1"],
  );
  assert.deepEqual(assignments.resolutions, ["implementer", "reviewer"]);
  const task = await loadValidated(store);
  assert.equal(task.metadata.retry.count, 0);
});

test("capacity wait supports multiple pauses in one Worker execution", async (t) => {
  const { root } = await createRepository(t);
  const time = fakeTime();
  const implementer = new CapacityWorker(
    deferred(CLOCK_START, 1_000, "continue-1"),
    deferred(CLOCK_START, 2_500, "continue-2"),
    implementation("after two refills"),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      implementer,
      reviewer: new ScriptedWorker(review("pass")),
    }),
    clock: time.clock,
    sleep: time.sleep,
  }).run(TASK_ID, { waitForCapacity: true });

  assert.equal(outcome.kind, "done");
  assert.deepEqual(time.sleeps, [1_000, 1_500]);
  assert.deepEqual(
    implementer.calls.map((call) => call.continuation),
    [null, "continue-1", "continue-2"],
  );
});

test("capacity pause limits apply across Role transitions in one run", async (t) => {
  const { root, store } = await createRepository(t);
  const time = fakeTime();
  const implementer = new CapacityWorker(
    deferred(CLOCK_START, 100, "continue-implementer"),
    implementation("after implementer refill"),
  );
  const reviewer = new CapacityWorker(
    deferred(CLOCK_START, 200, "continue-reviewer", "session-reviewer"),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer, reviewer }),
    clock: time.clock,
    sleep: time.sleep,
  }).run(TASK_ID, {
    waitForCapacity: true,
    maxCapacityPauses: 1,
    maxCapacityWaitMs: 1_000,
  });

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /pause limit exceeded/i);
  assert.deepEqual(time.sleeps, [100]);
  assert.equal(implementer.calls.length, 2);
  assert.equal(reviewer.calls.length, 1);
  const task = await loadValidated(store);
  assert.equal(task.metadata.state, "review");
  assert.equal(task.metadata.retry.count, 0);
});

test("capacity wait enforces pause count and cumulative wait bounds", async (t) => {
  await t.test("pause count", async (st) => {
    const { root, taskPath } = await createRepository(st);
    const before = await readFile(taskPath, "utf8");
    const time = fakeTime();
    const worker = new CapacityWorker(
      deferred(CLOCK_START, 100, "continue-1"),
      deferred(CLOCK_START, 200, "continue-2"),
    );
    const outcome = await new LoopEngine({
      root,
      assignments: new TrackingResolver({ implementer: worker }),
      clock: time.clock,
      sleep: time.sleep,
    }).run(TASK_ID, {
      waitForCapacity: true,
      maxCapacityPauses: 1,
      maxCapacityWaitMs: 1_000,
    });

    assert.equal(outcome.kind, "halted");
    assert.match(outcome.reason, /pause limit exceeded/i);
    assert.deepEqual(time.sleeps, [100]);
    assert.equal(worker.calls.length, 2);
    assert.equal(await readFile(taskPath, "utf8"), before);
  });

  await t.test("cumulative wait", async (st) => {
    const { root, taskPath } = await createRepository(st);
    const before = await readFile(taskPath, "utf8");
    const time = fakeTime();
    const worker = new CapacityWorker(
      deferred(CLOCK_START, 600, "continue-1"),
      deferred(CLOCK_START, 1_200, "continue-2"),
    );
    const outcome = await new LoopEngine({
      root,
      assignments: new TrackingResolver({ implementer: worker }),
      clock: time.clock,
      sleep: time.sleep,
    }).run(TASK_ID, {
      waitForCapacity: true,
      maxCapacityPauses: 4,
      maxCapacityWaitMs: 1_000,
    });

    assert.equal(outcome.kind, "halted");
    assert.match(outcome.reason, /wait limit exceeded/i);
    assert.deepEqual(time.sleeps, [600]);
    assert.equal(worker.calls.length, 2);
    assert.equal(await readFile(taskPath, "utf8"), before);
  });
});

test("capacity wait handles cancellation and sleep rejection without resuming", async (t) => {
  await t.test("cancellation", async (st) => {
    const { root } = await createRepository(st);
    const controller = new AbortController();
    controller.abort();
    const worker = new CapacityWorker(
      deferred(CLOCK_START, 100, "never-resume"),
    );
    const outcome = await new LoopEngine({
      root,
      assignments: new TrackingResolver({ implementer: worker }),
      clock: () => CLOCK_START,
      sleep: fakeTime().sleep,
    }).run(TASK_ID, { waitForCapacity: true, signal: controller.signal });

    assert.equal(outcome.kind, "halted");
    assert.match(outcome.reason, /cancelled/i);
    assert.equal(worker.calls.length, 1);
  });

  await t.test("sleep rejection", async (st) => {
    const { root } = await createRepository(st);
    const worker = new CapacityWorker(
      deferred(CLOCK_START, 100, "never-resume"),
    );
    const outcome = await new LoopEngine({
      root,
      assignments: new TrackingResolver({ implementer: worker }),
      clock: () => CLOCK_START,
      sleep: async () => {
        throw new Error("timer service unavailable");
      },
    }).run(TASK_ID, { waitForCapacity: true });

    assert.equal(outcome.kind, "halted");
    assert.match(outcome.reason, /wait failed: timer service unavailable/i);
    assert.equal(worker.calls.length, 1);
  });
});

test("a Task mutation while sleeping wins over capacity continuation", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const worker = new CapacityWorker(
    deferred(CLOCK_START, 100, "must-not-resume"),
  );

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: worker }),
    clock: () => CLOCK_START,
    sleep: async () => {
      await writeFile(taskPath, `${before}\n`, "utf8");
    },
  }).run(TASK_ID, { waitForCapacity: true });

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /changed while waiting/i);
  assert.equal(worker.calls.length, 1);
  assert.equal(await readFile(taskPath, "utf8"), `${before}\n`);
});

test("a stale capacity reset halts without sleeping", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  const worker = new CapacityWorker(
    new CapacityDeferredError("stale capacity reset", {
      retryAt: new Date(CLOCK_START).toISOString(),
      continuation: "never-resume",
      sessionId: "session-a",
    }),
  );
  let sleepCalls = 0;

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({ implementer: worker }),
    clock: () => CLOCK_START,
    sleep: async () => {
      sleepCalls += 1;
    },
  }).run(TASK_ID, { waitForCapacity: true });

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /stale or malformed/i);
  assert.equal(sleepCalls, 0);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("a generic Worker error never enters capacity sleep", async (t) => {
  const { root, taskPath } = await createRepository(t);
  const before = await readFile(taskPath, "utf8");
  let sleepCalls = 0;

  const outcome = await new LoopEngine({
    root,
    assignments: new TrackingResolver({
      implementer: new ScriptedWorker(new Error("ordinary worker failure")),
    }),
    clock: () => CLOCK_START,
    sleep: async () => {
      sleepCalls += 1;
    },
  }).run(TASK_ID, { waitForCapacity: true });

  assert.equal(outcome.kind, "halted");
  assert.match(outcome.reason, /ordinary worker failure/);
  assert.equal(sleepCalls, 0);
  assert.equal(await readFile(taskPath, "utf8"), before);
});

test("capacity wait bounds must be positive integers", async (t) => {
  const { root } = await createRepository(t);
  const engine = new LoopEngine({
    root,
    assignments: new TrackingResolver(),
  });

  for (const options of [
    { maxCapacityWaitMs: 0 },
    { maxCapacityWaitMs: 1.5 },
    { maxCapacityPauses: 0 },
    { maxCapacityPauses: Number.POSITIVE_INFINITY },
  ]) {
    const outcome = await engine.run(TASK_ID, options);
    assert.equal(outcome.kind, "halted");
    assert.equal(outcome.task, null);
    assert.match(outcome.reason, /positive integer/i);
  }
});
