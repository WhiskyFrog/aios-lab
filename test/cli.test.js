import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

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
