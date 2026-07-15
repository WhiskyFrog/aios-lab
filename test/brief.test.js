import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  createBrief,
  createPlanningTaskFile,
  MAX_BRIEF_TITLE_LENGTH,
  renderPlanningTask,
} from "../src/brief.js";
import { TaskStore } from "../src/documents.js";
import { LoopEngine } from "../src/engine.js";
import { initializeRepository } from "../src/init.js";
import {
  MAX_OBJECTIVE_BYTES,
  TARGET_ERROR_CATEGORIES,
  TargetContractError,
} from "../src/targets.js";
import { StaticAssignmentResolver } from "../src/workers.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");

async function repository(t, { name = "external-project", initialized = true } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "aios-brief-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, name);
  await mkdir(path.join(root, ".git"), { recursive: true });
  if (initialized) {
    await initializeRepository({ root });
  }
  return root;
}

async function filesUnder(root) {
  const files = [];
  async function visit(current, relative) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else {
        files.push(childRelative);
      }
    }
  }
  await visit(root, "");
  return files.sort();
}

async function seedTask(root, id, project = "external-project") {
  const rendered = renderPlanningTask({
    id,
    project,
    planId: `seed-${id}`,
    objective: `Seed ${id}`,
  });
  await writeFile(path.join(root, ".aios", "tasks", `${id}.md`), rendered.content);
}

function assertContract(error, category, pattern) {
  assert.ok(error instanceof TargetContractError);
  assert.equal(error.category, category);
  assert.equal(error.exitCode, category === TARGET_ERROR_CATEGORIES.OPERATOR_INPUT ? 64 : 1);
  assert.match(error.message, pattern);
  return true;
}

test("brief creates exactly one strict approval-required planning Task", async (t) => {
  const root = await repository(t);
  const objective = "  Build a portable payment flow.\r\nPreserve this second line exactly.  ";
  const before = await filesUnder(root);
  const result = await createBrief({
    root,
    objective,
    planId: "payment-flow",
  });
  const after = await filesUnder(root);
  assert.deepEqual(result, {
    kind: "created",
    task: "task-0001",
    plan: "payment-flow",
    project: "external-project",
  });
  assert.deepEqual(after.filter((file) => !before.includes(file)), [
    path.join(".aios", "tasks", "task-0001.md"),
  ]);

  const task = await new TaskStore(root).loadTask("task-0001");
  assert.equal(task.metadata.project, "external-project");
  assert.equal(task.metadata.approval, "required");
  assert.equal(task.metadata.state, "implement");
  assert.equal(task.metadata.last_review, null);
  assert.ok(Array.from(task.metadata.title).length <= MAX_BRIEF_TITLE_LENGTH);
  const briefStart = task.body.indexOf("## Brief\n\n") + "## Brief\n\n".length;
  const briefEnd = task.body.indexOf("\n\n## Planner Profiles", briefStart);
  assert.equal(task.body.slice(briefStart, briefEnd), objective);
  assert.match(task.body, /plans\/payment-flow\//);
  assert.match(task.body, /aios adopt plans\/payment-flow --root \. --check/);
  assert.match(task.body, /generic-goal/);
  assert.match(task.body, /software-feature/);
  assert.doesNotMatch(task.body, /Claude|Codex|aios-lab|[A-Z]:\\/i);
});

test("brief continues after the greatest Task id and reuses its project", async (t) => {
  const root = await repository(t, { name: "different-directory" });
  await seedTask(root, "task-0003", "established-project");
  await seedTask(root, "task-0012", "established-project");
  await writeFile(path.join(root, ".aios", "tasks", "notes.txt"), "ignored");
  const result = await createBrief({ root, objective: "Add an audit export" });
  assert.equal(result.task, "task-0013");
  assert.equal(result.project, "established-project");
  assert.equal(result.plan, "add-an-audit-export");
});

test("brief --check resolves the same ids and writes nothing", async (t) => {
  const root = await repository(t);
  const before = await filesUnder(root);
  const checked = await createBrief({
    root,
    objective: "Create a searchable activity page",
    checkOnly: true,
  });
  assert.deepEqual(checked, {
    kind: "checked",
    task: "task-0001",
    plan: "create-a-searchable-activity-page",
    project: "external-project",
  });
  assert.deepEqual(await filesUnder(root), before);
  const created = await createBrief({ root, objective: "Create a searchable activity page" });
  assert.deepEqual({ ...created, kind: "checked" }, checked);
});

test("brief rejects repository and initialization failures with bootstrap guidance", async (t) => {
  const uninitialized = await repository(t, { initialized: false });
  await assert.rejects(
    createBrief({ root: uninitialized, objective: "Build a feature" }),
    (error) => assertContract(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /run aios init/),
  );

  const partial = await repository(t);
  await rm(path.join(partial, ".aios", "tasks"), { recursive: true });
  await assert.rejects(
    createBrief({ root: partial, objective: "Build a feature" }),
    (error) => assertContract(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /tasks.*run aios init/),
  );
});

test("brief fails closed for unsafe input, identity, plan, and target conflicts", async (t) => {
  const root = await repository(t, { name: "Invalid Directory" });
  for (const [options, pattern, category] of [
    [{ objective: "   " }, /must not be empty/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "Safe\n## Injected" }, /Markdown ATX heading/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "Safe\n<!-- aios:attempt-frame v1 number=1 -->" }, /attempt-frame marker/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "a".repeat(MAX_OBJECTIVE_BYTES + 1) }, /maximum is/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "한글 목표만 있음", project: "valid-project" }, /supply --plan/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "Build a feature", planId: "Invalid Plan", project: "valid-project" }, /--plan has an invalid value/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "Build a feature", project: "Invalid Project" }, /--project/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
    [{ objective: "Build a feature" }, /supply --project/, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT],
  ]) {
    await assert.rejects(
      createBrief({ root, ...options }),
      (error) => assertContract(error, category, pattern),
    );
  }

  await mkdir(path.join(root, "plans", "existing-plan"), { recursive: true });
  await assert.rejects(
    createBrief({
      root,
      objective: "Build a feature",
      project: "valid-project",
      planId: "existing-plan",
    }),
    (error) => assertContract(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /plan already exists/),
  );
  assert.deepEqual(await readdir(path.join(root, ".aios", "tasks")), []);
});

test("exclusive Task creation rejects a stale or concurrent collision", async (t) => {
  const root = await repository(t);
  const taskPath = path.join(root, ".aios", "tasks", "task-0001.md");
  const task = renderPlanningTask({
    id: "task-0001",
    project: "external-project",
    planId: "collision-proof",
    objective: "Prove collision handling",
  });
  await createPlanningTaskFile(taskPath, task.content);
  const original = await readFile(taskPath, "utf8");
  await assert.rejects(
    createPlanningTaskFile(taskPath, `${task.content}\nchanged`),
    (error) => assertContract(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /Refusing to overwrite/),
  );
  assert.equal(await readFile(taskPath, "utf8"), original);
});

test("the generated Task reaches the Implementer Role without manual editing", async (t) => {
  const root = await repository(t);
  const created = await createBrief({ root, objective: "Design a searchable catalog" });
  const calls = [];
  const implementer = {
    async execute(task) {
      calls.push(task);
      return {
        schema: "aios.result/v1",
        task: task.metadata.id,
        role: "implementer",
        status: "failure",
        payload: { reason: "Stop after proving Implementer dispatch." },
      };
    },
  };
  const engine = new LoopEngine({
    root,
    assignments: new StaticAssignmentResolver({ implementer }),
  });
  const outcome = await engine.run(created.task);
  assert.equal(outcome.kind, "halted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.id, "task-0001");
  assert.match(calls[0].body, /plans\/design-a-searchable-catalog\//);
});

test("brief CLI creates and checks structured intake with stable exit codes", async (t) => {
  const root = await repository(t);
  const objective = "Create a multilingual release dashboard\nwith exact operator wording";
  const checked = await executeFile(
    process.execPath,
    [cli, "brief", objective, "--root", root, "--check"],
    { windowsHide: true },
  );
  assert.equal(JSON.parse(checked.stdout).kind, "checked");
  assert.deepEqual(await readdir(path.join(root, ".aios", "tasks")), []);
  const created = await executeFile(
    process.execPath,
    [cli, "brief", objective, "--root", root],
    { windowsHide: true },
  );
  assert.equal(JSON.parse(created.stdout).kind, "created");
  assert.ok((await readFile(path.join(root, ".aios", "tasks", "task-0001.md"), "utf8")).includes(objective));

  await assert.rejects(
    executeFile(process.execPath, [cli, "brief"], { windowsHide: true }),
    (error) => error.code === 64 && /Usage:/.test(error.stderr),
  );
  await assert.rejects(
    executeFile(process.execPath, [cli, "brief", "## Unsafe", "--root", root], { windowsHide: true }),
    (error) => error.code === 64 && /Markdown ATX heading/.test(error.stderr),
  );
  const uninitialized = await repository(t, { name: "not-initialized", initialized: false });
  await assert.rejects(
    executeFile(process.execPath, [cli, "brief", "Build a feature", "--root", uninitialized], { windowsHide: true }),
    (error) => error.code === 1 && /run aios init/.test(error.stderr),
  );
});
