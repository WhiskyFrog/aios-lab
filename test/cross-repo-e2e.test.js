import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { TaskStore } from "../src/documents.js";

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(sourceRoot, "src", "cli.js");
const demo = path.join(sourceRoot, "fixtures", "cross-repo-demo.js");
const worker = path.join(sourceRoot, "fixtures", "command-worker.js");

test("public CLI crosses a disposable external repository from init through dashboard", async () => {
  const { stdout, stderr } = await executeFile(process.execPath, [demo], {
    cwd: sourceRoot,
    windowsHide: true,
  });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.deepEqual(report.commands, [
    "git init <scratch>",
    "aios init --root <scratch> --from <config>",
    "aios brief <objective> --root <scratch> --plan portable-catalog",
    "aios run task-0001 --root <scratch>",
    "aios run task-0001 --root <scratch> (after approval)",
    "aios adopt plans/portable-catalog --root <scratch>",
    "aios progress plans/portable-catalog --root <scratch>",
    "aios dashboard --root <scratch>",
  ]);
  assert.equal(report.project, "scratch-product");
  assert.equal(report.planning_stop.state, "approval");
  assert.equal(report.planning_done.state, "done");
  assert.deepEqual(report.adoption.mapping, { "P-01": "task-0002" });
  assert.equal(report.progression.complete, true);
  assert.deepEqual(report.task_states, { "task-0001": "done", "task-0002": "done" });
  assert.deepEqual(report.reviews, ["pass", "pass"]);
  assert.equal(report.session_count, 4);
  assert.ok(report.artifacts.includes(".aios/approvals/task-0001"));
  assert.ok(report.artifacts.includes(".aios/runtime/sessions.json"));
  assert.ok(report.artifacts.includes("plans/portable-catalog/PLAN.md"));
  assert.ok(report.artifacts.includes("dashboard.html"));
  assert.equal(report.source_unchanged, true);
  assert.equal(report.temporary_root_removed, true);
  assert.equal(report.paid_or_network_processes, 0);
  assert.doesNotMatch(stdout, /[A-Za-z]:\\|\/(?:tmp|home)\//);
  assert.doesNotMatch(stdout, /claude|codex|https?:\/\//i);
});

function taskDocument() {
  const metadata = {
    schema: "aios.task/v1",
    id: "task-0001",
    project: "hand-prepared",
    title: "Keep hand-prepared operation working",
    state: "implement",
    retry: { count: 0, limit: 2 },
    approval: "not_required",
    last_review: null,
  };
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n
# Keep hand-prepared operation working

## Objective

Complete without running the bootstrap command.

## Acceptance Criteria

- The unchanged engine and dashboard operate on the hand-prepared layout.

## Constraints

- Use the deterministic fixture only.

## Context

Regression coverage for repositories created before aios init existed.

## Attempts

_None yet._
`;
}

test("run and dashboard still operate on a hand-prepared repository that never used init", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-hand-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"));
  await writeFile(path.join(root, ".aios", "tasks", "task-0001.md"), taskDocument());
  await writeFile(
    path.join(root, ".aios", "assignments.json"),
    JSON.stringify({
      schema: "aios.assignments/v1",
      assignments: {
        implementer: [process.execPath, worker, "auto-loop"],
        reviewer: [process.execPath, worker, "auto-loop"],
      },
    }),
  );

  const run = await executeFile(
    process.execPath,
    [cli, "run", "task-0001", "--root", root],
    { cwd: root, windowsHide: true },
  );
  assert.equal(JSON.parse(run.stdout).kind, "done");
  assert.equal((await new TaskStore(root).loadTask("task-0001")).metadata.state, "done");

  await executeFile(
    process.execPath,
    [cli, "dashboard", "--root", root],
    { cwd: root, windowsHide: true },
  );
  assert.match(await readFile(path.join(root, "dashboard.html"), "utf8"), /hand-prepared/);
  await assert.rejects(readFile(path.join(root, ".aios", ".gitignore"), "utf8"), /ENOENT/);
});
