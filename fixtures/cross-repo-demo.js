import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TaskStore } from "../src/documents.js";

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(sourceRoot, "src", "cli.js");
const worker = path.join(sourceRoot, "fixtures", "cross-repo-worker.js");
const humanApprover = path.join(sourceRoot, "workers", "human-approver.mjs");
const SNAPSHOT_EXCLUSIONS = new Set([".git", "node_modules"]);

async function sourceSnapshot() {
  const rows = [];
  async function visit(directory, relative) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (relative === "" && SNAPSHOT_EXCLUSIONS.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      const entryRelative = path.join(relative, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(entryPath)).digest("hex");
        rows.push([entryRelative, digest]);
      }
    }
  }
  await visit(sourceRoot, "");
  return rows;
}

function parseOutput(execution) {
  return JSON.parse(execution.stdout);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runCrossRepositoryDemo() {
  const beforeSource = await sourceSnapshot();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aios-cross-repo-demo-"));
  const root = path.join(workspace, "scratch-product");
  const configPath = path.join(workspace, "execution.json");
  const commands = [];
  const observation = {
    project: "scratch-product",
    plan: "portable-catalog",
    commands,
    planning_stop: null,
    planning_done: null,
    adoption: null,
    progression: null,
    task_states: null,
    reviews: null,
    session_count: 0,
    artifacts: [],
    source_unchanged: false,
    temporary_root_removed: false,
    paid_or_network_processes: 0,
  };

  const invoke = async (label, ...args) => {
    commands.push(label);
    return executeFile(process.execPath, [cli, ...args], {
      cwd: root,
      windowsHide: true,
    });
  };

  try {
    await mkdir(root, { recursive: true });
    commands.push("git init <scratch>");
    await executeFile("git", ["init", "--quiet", root], {
      cwd: workspace,
      windowsHide: true,
    });
    await writeFile(
      configPath,
      `${JSON.stringify({
        schema: "aios.assignments/v1",
        assignments: {
          implementer: [process.execPath, worker],
          reviewer: [process.execPath, worker],
          approver: [process.execPath, humanApprover],
        },
      }, null, 2)}\n`,
    );

    const initialized = parseOutput(await invoke(
      "aios init --root <scratch> --from <config>",
      "init",
      "--root",
      root,
      "--from",
      configPath,
    ));
    assert.equal(initialized.kind, "initialized");

    const intake = parseOutput(await invoke(
      "aios brief <objective> --root <scratch> --plan portable-catalog",
      "brief",
      "Build a portable catalog workflow in a separate repository",
      "--root",
      root,
      "--plan",
      "portable-catalog",
    ));
    assert.deepEqual(intake, {
      kind: "created",
      task: "task-0001",
      plan: "portable-catalog",
      project: "scratch-product",
    });

    let stopped;
    try {
      await invoke(
        "aios run task-0001 --root <scratch>",
        "run",
        "task-0001",
        "--root",
        root,
      );
    } catch (error) {
      stopped = error;
    }
    assert.equal(stopped?.code, 1);
    const rawPlanningStop = JSON.parse(stopped.stdout);
    observation.planning_stop = {
      ...rawPlanningStop,
      reason: rawPlanningStop.reason.replaceAll(root, "<scratch>"),
    };
    assert.equal(observation.planning_stop.state, "approval");
    assert.match(observation.planning_stop.reason, /awaiting human decision/);

    await writeFile(path.join(root, ".aios", "approvals", "task-0001"), "approved\n");
    observation.planning_done = parseOutput(await invoke(
      "aios run task-0001 --root <scratch> (after approval)",
      "run",
      "task-0001",
      "--root",
      root,
    ));
    assert.equal(observation.planning_done.kind, "done");

    observation.adoption = parseOutput(await invoke(
      "aios adopt plans/portable-catalog --root <scratch>",
      "adopt",
      "plans/portable-catalog",
      "--root",
      root,
    ));
    assert.deepEqual(observation.adoption.mapping, { "P-01": "task-0002" });

    observation.progression = parseOutput(await invoke(
      "aios progress plans/portable-catalog --root <scratch>",
      "progress",
      "plans/portable-catalog",
      "--root",
      root,
    ));
    assert.equal(observation.progression.complete, true);
    assert.deepEqual(observation.progression.completed, ["task-0002"]);

    await invoke(
      "aios dashboard --root <scratch>",
      "dashboard",
      "--root",
      root,
    );

    const store = new TaskStore(root);
    const planningTask = await store.loadTask("task-0001");
    const adoptedTask = await store.loadTask("task-0002");
    observation.task_states = {
      "task-0001": planningTask.metadata.state,
      "task-0002": adoptedTask.metadata.state,
    };
    assert.deepEqual(observation.task_states, {
      "task-0001": "done",
      "task-0002": "done",
    });
    const planningReview = await store.loadReview(planningTask.metadata.last_review);
    const adoptedReview = await store.loadReview(adoptedTask.metadata.last_review);
    observation.reviews = [
      planningReview.metadata.verdict,
      adoptedReview.metadata.verdict,
    ];
    assert.deepEqual(observation.reviews, ["pass", "pass"]);

    const sessions = JSON.parse(
      await readFile(path.join(root, ".aios", "runtime", "sessions.json"), "utf8"),
    );
    observation.session_count = sessions.sessions.length;
    assert.equal(observation.session_count, 4);

    const relativeArtifacts = [
      ".aios/tasks/task-0001.md",
      ".aios/tasks/task-0002.md",
      `.aios/reviews/${planningTask.metadata.last_review}.md`,
      `.aios/reviews/${adoptedTask.metadata.last_review}.md`,
      ".aios/approvals/task-0001",
      ".aios/runtime/sessions.json",
      "plans/portable-catalog/PLAN.md",
      "plans/portable-catalog/P-01.md",
      "dashboard.html",
    ];
    for (const relative of relativeArtifacts) {
      assert.equal(await exists(path.join(root, ...relative.split("/"))), true, relative);
    }
    observation.artifacts = relativeArtifacts;

    const dashboard = await readFile(path.join(root, "dashboard.html"), "utf8");
    assert.match(dashboard, /scratch-product/);
    assert.match(dashboard, /portable-catalog/);
    assert.deepEqual(await sourceSnapshot(), beforeSource);
    observation.source_unchanged = true;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    observation.temporary_root_removed = !(await exists(workspace));
  }

  assert.equal(observation.temporary_root_removed, true);
  return observation;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(`${JSON.stringify(await runCrossRepositoryDemo(), null, 2)}\n`);
}
