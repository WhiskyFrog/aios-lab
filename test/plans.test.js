import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore, parseDocumentFile } from "../src/documents.js";
import {
  adoptPlan,
  allocateTaskIds,
  inspectPlan,
  PLANNER_PROFILES,
  PlanValidationError,
} from "../src/plans.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");
const plannerWorker = path.join(projectRoot, "fixtures", "planner-worker.js");

function render(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function proposalDocument({
  id,
  project = "test-project",
  state = "implement",
  retry = { count: 0, limit: 2 },
  bodyReference = "",
} = {}) {
  return render(
    {
      schema: "aios.task/v1",
      id,
      project,
      title: `Proposal ${id}`,
      state,
      retry,
      approval: "not_required",
      last_review: null,
    },
    `
# Proposal ${id}

## Objective

Deliver one focused outcome. ${bodyReference}

## Acceptance Criteria

- The outcome has observable verification.

## Constraints

- Keep the work within one session.

## Context

Generated for plan testing.

## Attempts

_None yet._
`,
  );
}

function planDocument({
  id = "demo-plan",
  profile = "website",
  profileReason = "The brief is a multi-page website.",
  execution = ["P-01", "P-02"],
} = {}) {
  return render(
    {
      schema: "aios.plan/v1",
      id,
      project: "test-project",
      profile,
      profile_reason: profileReason,
    },
    `
# Demo plan

## Brief

Build a small responsive website.

## Profile Application

The selected profile separates shared foundations from page outcomes.

## Assumptions and Risks

Final copy is available; shared navigation is the principal integration risk.

## Decomposition Rationale

Each proposal is independently reviewable and fits one Worker session.

## Execution Order

${execution.map((proposal, index) => `${String(index + 1)}. ${proposal} is the next outcome.`).join("\n")}
`,
  );
}

async function makePlanRoot(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-plan-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasksDirectory = path.join(root, ".aios", "tasks");
  const planDirectory = path.join(root, "plans", options.id ?? "demo-plan");
  await mkdir(tasksDirectory, { recursive: true });
  await mkdir(planDirectory, { recursive: true });
  for (const filename of options.existingTaskFiles ?? []) {
    await writeFile(path.join(tasksDirectory, filename), "existing", "utf8");
  }
  await writeFile(
    path.join(planDirectory, "PLAN.md"),
    planDocument({ id: options.id ?? "demo-plan", ...(options.plan ?? {}) }),
    "utf8",
  );
  const proposalIds = options.proposalIds ?? ["P-01", "P-02"];
  for (const id of proposalIds) {
    await writeFile(
      path.join(planDirectory, `${id}.md`),
      proposalDocument({ id, ...(options.proposalOverrides?.[id] ?? {}) }),
      "utf8",
    );
  }
  return { root, planDirectory, tasksDirectory };
}

test("the initial Planner profile catalog is small, explicit, and has a generic fallback", () => {
  assert.deepEqual(Object.keys(PLANNER_PROFILES), [
    "generic-goal",
    "software-feature",
    "bug-fix",
    "website",
    "research",
    "migration",
    "content",
  ]);
  for (const profile of Object.values(PLANNER_PROFILES)) {
    assert.equal(typeof profile.decomposition, "string");
    assert.equal(typeof profile.verification, "string");
  }
});

test("inspectPlan validates profile evidence and an exact ordered proposal set", async (t) => {
  const { root, planDirectory } = await makePlanRoot(t);
  const inspection = await inspectPlan({ root, planDirectory });
  assert.equal(inspection.ok, true, inspection.problems.join("\n"));
  assert.equal(inspection.plan.metadata.profile, "website");
  assert.deepEqual(
    inspection.proposals.map((proposal) => proposal.id),
    ["P-01", "P-02"],
  );
});

test("inspectPlan aggregates profile, ordering, and proposal contract failures", async (t) => {
  const { root, planDirectory } = await makePlanRoot(t, {
    plan: {
      profile: "made-up-domain",
      profileReason: "",
      execution: ["P-01", "P-01", "P-99"],
    },
    proposalOverrides: {
      "P-02": { bodyReference: "This incorrectly depends on P-01." },
    },
  });
  const inspection = await inspectPlan({ root, planDirectory });
  assert.equal(inspection.ok, false);
  assert.match(inspection.problems.join("\n"), /profile must be one of/);
  assert.match(inspection.problems.join("\n"), /profile_reason/);
  assert.match(inspection.problems.join("\n"), /unknown proposal P-99/);
  assert.match(inspection.problems.join("\n"), /P-01 exactly once \(found 2\)/);
  assert.match(inspection.problems.join("\n"), /P-02 exactly once \(found 0\)/);
  assert.match(inspection.problems.join("\n"), /bodies cannot reference other proposals/);
});

test("proposal numbers must be contiguous and plan directories stay under root/plans", async (t) => {
  const { root, planDirectory } = await makePlanRoot(t, {
    proposalIds: ["P-01", "P-03"],
    plan: { execution: ["P-01", "P-03"] },
  });
  const sequence = await inspectPlan({ root, planDirectory });
  assert.match(sequence.problems.join("\n"), /contiguous sequence/);

  const outside = await inspectPlan({ root, planDirectory: path.join(root, "elsewhere") });
  assert.match(outside.problems.join("\n"), /direct child of <root>\/plans/);
});

test("allocateTaskIds continues after the greatest existing Task id", () => {
  assert.deepEqual(
    allocateTaskIds(["README.md", "task-0009.md", "task-0015.md"], 3),
    ["task-0016", "task-0017", "task-0018"],
  );
});

test("--check returns plan evidence without writing Tasks or rewriting PLAN.md", async (t) => {
  const { root, planDirectory, tasksDirectory } = await makePlanRoot(t);
  const before = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
  const result = await adoptPlan({ root, planDirectory, checkOnly: true });
  assert.deepEqual(result, {
    kind: "checked",
    plan: "demo-plan",
    profile: "website",
    proposals: ["P-01", "P-02"],
  });
  assert.deepEqual(await readdir(tasksDirectory), []);
  assert.equal(await readFile(path.join(planDirectory, "PLAN.md"), "utf8"), before);
});

test("adoption allocates sequential ids, preserves bodies, and rewrites PLAN.md", async (t) => {
  const { root, planDirectory } = await makePlanRoot(t, {
    existingTaskFiles: ["task-0009.md", "task-0015.md"],
  });
  const proposal = parseDocumentFile(
    await readFile(path.join(planDirectory, "P-01.md"), "utf8"),
  );
  const result = await adoptPlan({ root, planDirectory });
  assert.deepEqual(result.mapping, { "P-01": "task-0016", "P-02": "task-0017" });

  const store = new TaskStore(root);
  const first = await store.loadTask("task-0016");
  const second = await store.loadTask("task-0017");
  assert.equal(first.metadata.id, "task-0016");
  assert.equal(second.metadata.id, "task-0017");
  assert.equal(first.body, proposal.body);
  const rewritten = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
  assert.doesNotMatch(rewritten, /\bP-[0-9]{2,}\b/);
  assert.match(rewritten, /task-0016/);
  assert.match(rewritten, /task-0017/);
});

test("invalid plans fail before any adoption write", async (t) => {
  const { root, planDirectory, tasksDirectory } = await makePlanRoot(t, {
    plan: { profile: "unknown" },
  });
  const before = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
  await assert.rejects(
    adoptPlan({ root, planDirectory }),
    (error) => error instanceof PlanValidationError && error.problems.length > 0,
  );
  assert.deepEqual(await readdir(tasksDirectory), []);
  assert.equal(await readFile(path.join(planDirectory, "PLAN.md"), "utf8"), before);
});

test("adopt CLI distinguishes check, validation failure, and usage errors", async (t) => {
  const { root } = await makePlanRoot(t);
  const checked = await executeFile(
    process.execPath,
    [cli, "adopt", "plans/demo-plan", "--root", root, "--check"],
    { cwd: root, windowsHide: true },
  );
  assert.equal(JSON.parse(checked.stdout).kind, "checked");

  await assert.rejects(
    executeFile(process.execPath, [cli, "adopt", "plans/missing", "--root", root], {
      cwd: root,
      windowsHide: true,
    }),
    (error) => error.code === 1 && /unable to read plan directory/.test(error.stderr),
  );
  await assert.rejects(
    executeFile(process.execPath, [cli, "adopt"], { windowsHide: true }),
    (error) => error.code === 64 && /Usage:/.test(error.stderr),
  );
});

function planningTaskDocument() {
  return render(
    {
      schema: "aios.task/v1",
      id: "task-9001",
      project: "test-project",
      title: "Plan a two-page website",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "required",
      last_review: null,
    },
    `
# Plan a two-page website

## Objective

Decompose a responsive home and about website into reviewed proposals.

## Acceptance Criteria

- A website-profile plan passes aios adopt --check.

## Attempts

_None yet._
`,
  );
}

test("a command Worker-backed planning Task reaches done and its plan adopts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-planner-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-9001.md"),
    planningTaskDocument(),
    "utf8",
  );
  const assignments = path.join(root, ".aios", "assignments.json");
  await writeFile(
    assignments,
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: {
        implementer: [process.execPath, plannerWorker, cli],
        reviewer: [process.execPath, plannerWorker, cli],
        approver: [process.execPath, plannerWorker, cli],
      },
    }),
    "utf8",
  );

  const run = await executeFile(
    process.execPath,
    [cli, "run", "task-9001", "--root", root, "--assignments", assignments],
    { cwd: root, windowsHide: true },
  );
  assert.equal(JSON.parse(run.stdout).kind, "done");
  const planningTask = await new TaskStore(root).loadTask("task-9001");
  assert.match(planningTask.body, /aios adopt --check passed/);
  assert.equal(planningTask.metadata.approval, "approved");

  const adopted = await executeFile(
    process.execPath,
    [cli, "adopt", "plans/site-plan", "--root", root],
    { cwd: root, windowsHide: true },
  );
  const report = JSON.parse(adopted.stdout);
  assert.deepEqual(report.mapping, {
    "P-01": "task-9002",
    "P-02": "task-9003",
    "P-03": "task-9004",
  });
  const store = new TaskStore(root);
  for (const taskId of Object.values(report.mapping)) {
    const task = await store.loadTask(taskId);
    assert.equal(task.metadata.state, "implement");
    assert.equal(task.metadata.retry.count, 0);
  }
});
