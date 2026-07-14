import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import {
  inspectTarget,
  MAX_DERIVED_PLAN_ID_LENGTH,
  MAX_OBJECTIVE_BYTES,
  resolvePlanId,
  resolveProjectId,
  TARGET_ERROR_CATEGORIES,
  TARGET_STATUSES,
  TargetContractError,
  validateObjective,
} from "../src/targets.js";

const temporaryRoots = [];

test.afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function temporaryDirectory(prefix = "aios-target-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function repository({ name = "demo-project", gitFile = false, aios = false } = {}) {
  const parent = await temporaryDirectory();
  const root = path.join(parent, name);
  await mkdir(root);
  if (gitFile) {
    await writeFile(path.join(root, ".git"), "gitdir: elsewhere\n");
  } else {
    await mkdir(path.join(root, ".git"));
  }
  if (aios) {
    await mkdir(path.join(root, ".aios"));
  }
  return root;
}

function render(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function taskDocument(id, project = "demo-project") {
  return render(
    {
      schema: "aios.task/v1",
      id,
      project,
      title: `Task ${id}`,
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    },
    `
# Task ${id}

## Objective

Deliver the requested result.

## Acceptance Criteria

- The result is observable.

## Constraints

- Stay in scope.

## Context

Target contract test.

## Attempts

_None yet._
`,
  );
}

async function writeTask(root, id, project = "demo-project") {
  const directory = path.join(root, ".aios", "tasks");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.md`), taskDocument(id, project));
}

async function snapshot(directory) {
  const values = [];
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryRelative = path.join(relative, entry.name);
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        values.push([entryRelative, "directory"]);
        await visit(entryPath, entryRelative);
      } else {
        values.push([entryRelative, "file", await readFile(entryPath, "base64")]);
      }
    }
  }
  await visit(directory, "");
  return values;
}

function assertContractError(error, category, message) {
  assert.ok(error instanceof TargetContractError);
  assert.equal(error.category, category);
  assert.equal(
    error.exitCode,
    category === TARGET_ERROR_CATEGORIES.OPERATOR_INPUT ? 64 : 1,
  );
  assert.match(error.message, message);
  return true;
}

test("target inspection classifies non-directories and repository-root shapes", async () => {
  const missing = path.join(await temporaryDirectory(), "missing");
  const missingResult = await inspectTarget(missing);
  assert.equal(missingResult.status, TARGET_STATUSES.NOT_DIRECTORY);
  assert.match(missingResult.reason, /is not a directory/);

  const file = path.join(await temporaryDirectory(), "file");
  await writeFile(file, "not a directory");
  assert.equal((await inspectTarget(file)).status, TARGET_STATUSES.NOT_DIRECTORY);

  const ordinaryDirectory = await temporaryDirectory();
  const ordinaryResult = await inspectTarget(ordinaryDirectory);
  assert.equal(ordinaryResult.status, TARGET_STATUSES.NOT_REPOSITORY_ROOT);
  assert.match(ordinaryResult.reason, /\.git.*missing/);

  const bare = await temporaryDirectory("bare-repository-");
  await writeFile(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  await mkdir(path.join(bare, "objects"));
  const bareResult = await inspectTarget(bare);
  assert.equal(bareResult.status, TARGET_STATUSES.NOT_REPOSITORY_ROOT);
  assert.match(bareResult.reason, /bare repositories/);
});

test("both direct .git forms classify a repository without .aios as uninitialized", async () => {
  const directoryForm = await repository();
  const fileForm = await repository({ gitFile: true });
  assert.equal((await inspectTarget(directoryForm)).status, TARGET_STATUSES.UNINITIALIZED);
  assert.equal((await inspectTarget(fileForm)).status, TARGET_STATUSES.UNINITIALIZED);
});

test("target inspection reports conflicting .aios and scaffold entry shapes by path", async () => {
  const root = await repository();
  await writeFile(path.join(root, ".aios"), "wrong shape");
  const aiosConflict = await inspectTarget(root);
  assert.equal(aiosConflict.status, TARGET_STATUSES.CONFLICTING);
  assert.match(aiosConflict.reason, /\.aios.*must be a directory/);

  const partial = await repository({ aios: true });
  await writeFile(path.join(partial, ".aios", "tasks"), "wrong shape");
  const tasksConflict = await inspectTarget(partial);
  assert.equal(tasksConflict.status, TARGET_STATUSES.CONFLICTING);
  assert.match(tasksConflict.reason, /\.aios[\\/]tasks.*must be a directory/);
});

test("initialized inspection reuses config and Task loaders without writing", async () => {
  const root = await repository({ aios: true });
  for (const name of ["reviews", "results", "approvals", "runtime"]) {
    await mkdir(path.join(root, ".aios", name));
  }
  await writeTask(root, "task-0001");
  await writeFile(
    path.join(root, ".aios", "assignments.json"),
    `${JSON.stringify({ schema: "aios.assignments/v1", assignments: {} }, null, 2)}\n`,
  );
  const before = await snapshot(root);
  const inspected = await inspectTarget(root);
  const after = await snapshot(root);
  assert.equal(inspected.status, TARGET_STATUSES.INITIALIZED);
  assert.deepEqual(inspected.taskProjects, ["demo-project"]);
  assert.deepEqual(after, before);
});

test("invalid existing execution configuration carries its canonical validation message", async () => {
  const root = await repository({ aios: true });
  const configPath = path.join(root, ".aios", "assignments.json");
  await writeFile(configPath, '{"schema":"aios.unknown/v1"}\n');
  const inspected = await inspectTarget(root);
  assert.equal(inspected.status, TARGET_STATUSES.CONFLICTING);
  assert.match(inspected.reason, /assignments\.json/);
  assert.match(
    inspected.reason,
    /config\.schema: must be aios\.assignments\/v1 or aios\.routing\/v1/,
  );
});

test("invalid existing Task document makes initialized state conflicting", async () => {
  const root = await repository({ aios: true });
  await mkdir(path.join(root, ".aios", "tasks"));
  await writeFile(path.join(root, ".aios", "tasks", "task-0001.md"), "not front matter");
  const inspected = await inspectTarget(root);
  assert.equal(inspected.status, TARGET_STATUSES.CONFLICTING);
  assert.match(inspected.reason, /Task task-0001/);
});

test("project resolution reuses Task identity and rejects an explicit conflict", async () => {
  const root = await repository({ name: "different-root", aios: true });
  await writeTask(root, "task-0001", "established-project");
  await writeTask(root, "task-0002", "established-project");
  assert.equal(await resolveProjectId({ root }), "established-project");
  assert.equal(
    await resolveProjectId({ root, project: "established-project" }),
    "established-project",
  );
  await assert.rejects(
    resolveProjectId({ root, project: "other-project" }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /conflicts with existing Task project/,
    ),
  );
});

test("project resolution uses explicit input, then an already-valid root basename", async () => {
  const explicitRoot = await repository({ name: "Invalid Root", aios: true });
  assert.equal(
    await resolveProjectId({ root: explicitRoot, project: "explicit-project" }),
    "explicit-project",
  );

  const basenameRoot = await repository({ name: "basename-project" });
  assert.equal(await resolveProjectId({ root: basenameRoot }), "basename-project");
});

test("project resolution distinguishes malformed input, missing input, and target conflict", async () => {
  const invalidRoot = await repository({ name: "Invalid Root", aios: true });
  await assert.rejects(
    resolveProjectId({ root: invalidRoot, project: "Not Normalized" }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /--project has an invalid value/,
    ),
  );
  await assert.rejects(
    resolveProjectId({ root: invalidRoot }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /supply --project/,
    ),
  );

  const conflictingRoot = await repository({ aios: true });
  await writeTask(conflictingRoot, "task-0001", "first-project");
  await writeTask(conflictingRoot, "task-0002", "second-project");
  await assert.rejects(
    resolveProjectId({ root: conflictingRoot }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.TARGET_STATE,
      /conflicting Task project values/,
    ),
  );
});

test("project resolution maps unusable repository state to a target-state error", async () => {
  const root = await temporaryDirectory();
  await assert.rejects(
    resolveProjectId({ root }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.TARGET_STATE,
      /\.git.*missing/,
    ),
  );
});

test("plan id accepts the existing pattern and derives a deterministic bounded slug", () => {
  assert.equal(
    resolvePlanId({ objective: "ignored", planId: "explicit-plan-2" }),
    "explicit-plan-2",
  );
  assert.equal(
    resolvePlanId({ objective: "  Build!!! A safer, Cross-Repository workflow.  " }),
    "build-a-safer-cross-repository-workflow",
  );
  const bounded = resolvePlanId({ objective: `${"leading ".repeat(20)}words` });
  assert.ok(bounded.length <= MAX_DERIVED_PLAN_ID_LENGTH);
  assert.doesNotMatch(bounded, /-$/);
});

test("invalid explicit plan id and underivable objective are distinct operator errors", () => {
  assert.throws(
    () => resolvePlanId({ objective: "usable", planId: "Invalid Plan" }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /--plan-id has an invalid value/,
    ),
  );
  assert.throws(
    () => resolvePlanId({ objective: "한글 목표 🚀" }),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /cannot produce a plan id; supply --plan-id/,
    ),
  );
});

test("objective validation rejects empty and over-limit values at exact byte boundaries", () => {
  assert.throws(
    () => validateObjective(" \r\n\t "),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /must not be empty/,
    ),
  );
  const boundary = "a".repeat(MAX_OBJECTIVE_BYTES);
  assert.equal(validateObjective(boundary), boundary);
  assert.throws(
    () => validateObjective(`${boundary}a`),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      new RegExp(`maximum is ${MAX_OBJECTIVE_BYTES} bytes`),
    ),
  );
  const unicodeBoundary = "가".repeat(Math.floor(MAX_OBJECTIVE_BYTES / 3));
  assert.equal(validateObjective(unicodeBoundary), unicodeBoundary);
});

test("objective validation rejects Markdown headings and attempt-frame markers distinctly", () => {
  assert.throws(
    () => validateObjective("Context\n## Injected heading"),
    /Markdown ATX heading/,
  );
  assert.throws(
    () => validateObjective("Injected heading\n---"),
    /Markdown Setext heading/,
  );
  assert.throws(
    () => validateObjective("Context\n<!-- aios:attempt-frame v1 task=task-0001 -->"),
    /AIOS attempt-frame marker/,
  );
  assert.throws(
    () => validateObjective("Context\n<!-- /aios:attempt-frame -->"),
    /AIOS attempt-frame marker/,
  );
  assert.throws(
    () => validateObjective("Context\r# Heading after a bare carriage return"),
    /Markdown ATX heading/,
  );
});

test("accepted objective is returned byte-for-byte unchanged", () => {
  const objective = "  Keep leading spaces\r\n\r\nPreserve\tall trailing bytes.  \r\n";
  assert.equal(validateObjective(objective), objective);
  assert.deepEqual(Buffer.from(validateObjective(objective)), Buffer.from(objective));
});

test("inspectTarget rejects malformed root input as operator input", async () => {
  await assert.rejects(
    inspectTarget(""),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /non-empty path/,
    ),
  );
  await assert.rejects(
    inspectTarget(null),
    (error) => assertContractError(
      error,
      TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
      /non-empty path/,
    ),
  );
});

test("classification results and their project evidence are immutable", async () => {
  const root = await repository({ aios: true });
  await writeTask(root, "task-0001");
  const inspected = await inspectTarget(root);
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(inspected.taskProjects), true);
  assert.throws(() => inspected.taskProjects.push("other"), TypeError);
  assert.equal((await lstat(root)).isDirectory(), true);
});
