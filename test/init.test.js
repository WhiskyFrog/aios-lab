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
import { stringify } from "yaml";

import { AIOS_GITIGNORE, initializeRepository } from "../src/init.js";
import { TARGET_ERROR_CATEGORIES, TargetContractError } from "../src/targets.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");
const workerFixture = path.join(projectRoot, "fixtures", "command-worker.js");

async function repository(t, { gitFile = false, name = "target-project" } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "aios-init-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, name);
  await mkdir(root);
  if (gitFile) {
    await writeFile(path.join(root, ".git"), "gitdir: elsewhere\n");
  } else {
    await mkdir(path.join(root, ".git"));
  }
  return root;
}

function assignmentConfig(command = [process.execPath, workerFixture, "auto-loop"]) {
  return {
    schema: "aios.assignments/v1",
    assignments: { implementer: command, reviewer: command },
  };
}

function routingConfig(command = [process.execPath, workerFixture, "auto-loop"]) {
  return {
    schema: "aios.routing/v1",
    tiers: [{ id: "high", rank: 1 }],
    capabilities: ["filesystem"],
    cost_classes: ["standard"],
    latency_classes: ["standard"],
    candidates: [{
      id: "fixture-high",
      provider: "fixture",
      model: "fixture-model",
      tier: "high",
      roles: ["implementer", "reviewer"],
      command,
      enabled: true,
      context_limit: 100_000,
      capabilities: ["filesystem"],
      cost_class: "standard",
      latency_class: "standard",
    }],
    policy: {
      high_tier: "high",
      distribution_window: 10,
      provider_targets: [{ provider: "fixture", weight: 1 }],
      limits: { fallbacks_per_action: 1, escalations_per_task: 1 },
      default_budgets: { cost: "standard", latency: "standard" },
    },
    hints: [],
    overrides: [],
  };
}

async function writeConfig(filePath, value = assignmentConfig()) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, raw);
  return raw;
}

async function treeSnapshot(root) {
  const rows = [];
  async function visit(current, relative) {
    for (const entry of (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(current, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        rows.push([name, "directory"]);
        await visit(child, name);
      } else {
        rows.push([name, "file", await readFile(child, "base64")]);
      }
    }
  }
  await visit(root, "");
  return rows;
}

function taskDocument() {
  const metadata = {
    schema: "aios.task/v1",
    id: "task-0001",
    project: "target-project",
    title: "Cross-repository smoke task",
    state: "implement",
    retry: { count: 0, limit: 2 },
    approval: "not_required",
    last_review: null,
  };
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n
# Cross-repository smoke task

## Objective

Complete through the installed command adapter.

## Acceptance Criteria

- The real engine reaches done.

## Constraints

- Use only the fixture Worker.

## Context

Created after aios init.

## Attempts

_None yet._
`;
}

function assertCategory(error, category, pattern) {
  assert.ok(error instanceof TargetContractError);
  assert.equal(error.category, category);
  assert.match(error.message, pattern);
  return true;
}

test("fresh initialization supports both .git forms and creates the exact scaffold", async (t) => {
  for (const gitFile of [false, true]) {
    const root = await repository(t, { gitFile, name: gitFile ? "file-form" : "dir-form" });
    const source = path.join(path.dirname(root), `source-${gitFile}.json`);
    const raw = await writeConfig(source);
    const result = await initializeRepository({ root, from: source });
    assert.equal(result.kind, "initialized");
    assert.deepEqual(
      result.actions.map(({ path: actionPath, action }) => [actionPath, action]),
      [
        [".aios", "created"],
        [".aios/tasks", "created"],
        [".aios/reviews", "created"],
        [".aios/results", "created"],
        [".aios/approvals", "created"],
        [".aios/runtime", "created"],
        [".aios/.gitignore", "created"],
        [".aios/assignments.json", "created"],
      ],
    );
    assert.equal(await readFile(path.join(root, ".aios", ".gitignore"), "utf8"), AIOS_GITIGNORE);
    assert.equal(await readFile(path.join(root, ".aios", "assignments.json"), "utf8"), raw);
  }
});

test("initialization is idempotent and preserves existing config and .gitignore", async (t) => {
  const root = await repository(t);
  const firstSource = path.join(path.dirname(root), "first.json");
  const secondSource = path.join(path.dirname(root), "second.json");
  const firstRaw = await writeConfig(firstSource);
  await writeConfig(secondSource, assignmentConfig([process.execPath, workerFixture, "corrected-loop"]));
  await initializeRepository({ root, from: firstSource });
  await writeFile(path.join(root, ".aios", ".gitignore"), "operator-owned\n");
  const result = await initializeRepository({ root, from: secondSource });
  assert.ok(result.actions.every(({ action }) => action === "already_present"));
  assert.equal(await readFile(path.join(root, ".aios", ".gitignore"), "utf8"), "operator-owned\n");
  assert.equal(await readFile(path.join(root, ".aios", "assignments.json"), "utf8"), firstRaw);
});

test("--check validates everything and reports actions without any write", async (t) => {
  const root = await repository(t);
  const source = path.join(path.dirname(root), "source.json");
  await writeConfig(source);
  const before = await treeSnapshot(root);
  const result = await initializeRepository({ root, from: source, checkOnly: true });
  const after = await treeSnapshot(root);
  assert.equal(result.kind, "checked");
  assert.ok(result.actions.every(({ action }) => action === "would_create"));
  assert.deepEqual(after, before);
});

test("partial hand-prepared repositories gain only missing entries", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  const result = await initializeRepository({ root });
  const actions = new Map(result.actions.map(({ path: actionPath, action }) => [actionPath, action]));
  assert.equal(actions.get(".aios"), "already_present");
  assert.equal(actions.get(".aios/tasks"), "already_present");
  assert.equal(actions.get(".aios/reviews"), "created");
  assert.equal(actions.has(".aios/assignments.json"), false);
});

test("target conflicts fail before writing and are target-state errors", async (t) => {
  const ordinary = await mkdtemp(path.join(os.tmpdir(), "aios-init-nonrepo-"));
  t.after(() => rm(ordinary, { recursive: true, force: true }));
  const before = await treeSnapshot(ordinary);
  await assert.rejects(
    initializeRepository({ root: ordinary }),
    (error) => assertCategory(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /\.git.*missing/),
  );
  assert.deepEqual(await treeSnapshot(ordinary), before);

  const invalidConfigRoot = await repository(t, { name: "invalid-config" });
  await mkdir(path.join(invalidConfigRoot, ".aios"));
  await writeFile(
    path.join(invalidConfigRoot, ".aios", "assignments.json"),
    '{"schema":"invalid"}\n',
  );
  await assert.rejects(
    initializeRepository({ root: invalidConfigRoot }),
    (error) => assertCategory(error, TARGET_ERROR_CATEGORIES.TARGET_STATE, /config\.schema/),
  );
  assert.deepEqual(await readdir(path.join(invalidConfigRoot, ".aios")), ["assignments.json"]);
});

test("--from accepts absolute and target-relative adapter files", async (t) => {
  const absoluteRoot = await repository(t, { name: "absolute-path" });
  const absoluteSource = path.join(path.dirname(absoluteRoot), "absolute.json");
  await writeConfig(absoluteSource, assignmentConfig([process.execPath, absoluteRoot]));
  await initializeRepository({ root: absoluteRoot, from: absoluteSource });

  const relativeRoot = await repository(t, { name: "relative-path" });
  await mkdir(path.join(relativeRoot, "workers"));
  await writeFile(path.join(relativeRoot, "workers", "adapter.js"), "// fixture\n");
  const relativeSource = path.join(path.dirname(relativeRoot), "relative.json");
  await writeConfig(relativeSource, assignmentConfig(["node", "workers/adapter.js"]));
  await initializeRepository({ root: relativeRoot, from: relativeSource });
  assert.equal(
    JSON.parse(await readFile(path.join(relativeRoot, ".aios", "assignments.json"), "utf8"))
      .assignments.implementer[1],
    "workers/adapter.js",
  );
});

test("--from installs a validated routing configuration through the same path", async (t) => {
  const root = await repository(t, { name: "routing-config" });
  const source = path.join(path.dirname(root), "routing.json");
  await writeConfig(source, routingConfig());
  await initializeRepository({ root, from: source });
  const installed = JSON.parse(
    await readFile(path.join(root, ".aios", "assignments.json"), "utf8"),
  );
  assert.equal(installed.schema, "aios.routing/v1");
  assert.equal(installed.candidates[0].id, "fixture-high");
});

test("--from rejects invalid schemas and unresolvable or escaping path tokens before writing", async (t) => {
  for (const [name, config, pattern] of [
    ["bad-schema", { schema: "bad" }, /config\.schema/],
    ["missing-path", assignmentConfig(["node", "workers/missing.js"]), /must resolve to an existing file/],
    ["escape-path", assignmentConfig(["node", "../outside.js"]), /escapes target root/],
  ]) {
    const root = await repository(t, { name });
    const source = path.join(path.dirname(root), `${name}.json`);
    await writeConfig(source, config);
    const before = await treeSnapshot(root);
    await assert.rejects(
      initializeRepository({ root, from: source }),
      (error) => assertCategory(error, TARGET_ERROR_CATEGORIES.OPERATOR_INPUT, pattern),
    );
    assert.deepEqual(await treeSnapshot(root), before);
  }
});

test("init CLI reports success, check mode, target failures, and usage errors", async (t) => {
  const root = await repository(t);
  const source = path.join(path.dirname(root), "source.json");
  await writeConfig(source);
  const checked = await executeFile(
    process.execPath,
    [cli, "init", "--root", root, "--from", source, "--check"],
    { windowsHide: true },
  );
  assert.equal(JSON.parse(checked.stdout).kind, "checked");
  assert.deepEqual(await readdir(root), [".git"]);
  const initialized = await executeFile(
    process.execPath,
    [cli, "init", "--root", root, "--from", source],
    { windowsHide: true },
  );
  assert.equal(JSON.parse(initialized.stdout).kind, "initialized");

  const nonrepo = await mkdtemp(path.join(os.tmpdir(), "aios-init-cli-nonrepo-"));
  t.after(() => rm(nonrepo, { recursive: true, force: true }));
  await assert.rejects(
    executeFile(process.execPath, [cli, "init", "--root", nonrepo], { windowsHide: true }),
    (error) => error.code === 1 && /\.git.*missing/.test(error.stderr),
  );
  await assert.rejects(
    executeFile(process.execPath, [cli, "init", "--unknown"], { windowsHide: true }),
    (error) => error.code === 64 && /Missing value for --unknown/.test(error.stderr),
  );
});

test("an initialized external repository works with existing dashboard and run commands", async (t) => {
  const root = await repository(t);
  const source = path.join(path.dirname(root), "source.json");
  await writeConfig(source);
  await executeFile(
    process.execPath,
    [cli, "init", "--root", root, "--from", source],
    { windowsHide: true },
  );
  await executeFile(
    process.execPath,
    [cli, "dashboard", "--root", root],
    { windowsHide: true },
  );
  assert.match(await readFile(path.join(root, "dashboard.html"), "utf8"), /AIOS Loop Dashboard/);

  await writeFile(path.join(root, ".aios", "tasks", "task-0001.md"), taskDocument());
  const run = await executeFile(
    process.execPath,
    [cli, "run", "task-0001", "--root", root],
    { cwd: root, windowsHide: true },
  );
  assert.equal(JSON.parse(run.stdout).kind, "done");
});
