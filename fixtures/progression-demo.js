import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(sourceRoot, "src", "cli.js");
const worker = path.join(sourceRoot, "fixtures", "command-worker.js");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aios-progression-demo-"));
const planDirectory = path.join(temporaryRoot, "plans", "disposable-demo");
const assignments = {
  schema: "aios.assignments/v1",
  assignments: {
    implementer: [process.execPath, worker, "auto-loop"],
    reviewer: [process.execPath, worker, "auto-loop"],
  },
};

function proposal(id) {
  return `---
schema: aios.task/v1
id: ${id}
project: disposable-demo
title: Deliver ${id}
state: implement
retry: {count: 0, limit: 2}
approval: not_required
last_review: null
---

# Deliver ${id}

## Objective

Complete deterministic demo work.

## Acceptance Criteria

- The fixture Worker succeeds.

## Constraints

- Remain inside the temporary root.

## Context

Disposable end-to-end demonstration.

## Attempts

_None yet._
`;
}

const observation = {
  temporary_root: temporaryRoot,
  setup_files: [],
  assignments,
  commands: [],
  adoption: null,
  progression: null,
  inspections: [],
  cleanup: `node:fs/promises.rm(${JSON.stringify(temporaryRoot)}, { recursive: true, force: true })`,
  temporary_root_removed: false,
};

try {
  await mkdir(path.join(temporaryRoot, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(temporaryRoot, ".aios", "reviews"), { recursive: true });
  await mkdir(planDirectory, { recursive: true });
  const planPath = path.join(planDirectory, "PLAN.md");
  await writeFile(
    planPath,
    `---
schema: aios.plan/v1
id: disposable-demo
project: disposable-demo
profile: software-feature
profile_reason: Prove the assembled CLI workflow.
---

# Disposable demo

## Brief

Complete two Tasks in order.

## Profile Application

Each proposal is independently verifiable.

## Assumptions and Risks

The deterministic fixture is available.

## Decomposition Rationale

Two Tasks make ordering observable.

## Execution Order

1. P-01 runs first.
2. P-02 runs second.
`,
    "utf8",
  );
  observation.setup_files.push(planPath);
  for (const id of ["P-01", "P-02"]) {
    const proposalPath = path.join(planDirectory, `${id}.md`);
    await writeFile(proposalPath, proposal(id), "utf8");
    observation.setup_files.push(proposalPath);
  }
  const assignmentsPath = path.join(temporaryRoot, ".aios", "assignments.json");
  await writeFile(assignmentsPath, JSON.stringify(assignments), "utf8");
  observation.setup_files.push(assignmentsPath);

  const adoptArguments = [
    cli,
    "adopt",
    planDirectory,
    "--root",
    temporaryRoot,
  ];
  observation.commands.push([process.execPath, ...adoptArguments]);
  const adopted = await executeFile(process.execPath, adoptArguments, {
    cwd: temporaryRoot,
    windowsHide: true,
  });
  observation.adoption = JSON.parse(adopted.stdout);

  const progressArguments = [
    cli,
    "progress",
    planDirectory,
    "--root",
    temporaryRoot,
    "--assignments",
    assignmentsPath,
  ];
  observation.commands.push([process.execPath, ...progressArguments]);
  const progressed = await executeFile(process.execPath, progressArguments, {
    cwd: temporaryRoot,
    windowsHide: true,
  });
  observation.progression = JSON.parse(progressed.stdout);

  for (const id of ["task-0001", "task-0002"]) {
    const taskPath = path.join(temporaryRoot, ".aios", "tasks", `${id}.md`);
    const raw = await readFile(taskPath, "utf8");
    observation.inspections.push({
      command: `read ${taskPath} front matter state`,
      task: id,
      state: parse(raw.split("---", 3)[1]).state,
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  try {
    await access(temporaryRoot);
  } catch {
    observation.temporary_root_removed = true;
  }
}

process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
