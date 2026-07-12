#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeDashboard } from "./dashboard.js";
import { LoopEngine } from "./engine.js";
import { FileAssignmentResolver } from "./workers.js";

function usage() {
  return [
    "Usage:",
    "  aios run <task-id> [--root <path>] [--assignments <path>] [--timeout-ms <n>]",
    "       [--wait-for-capacity] [--max-capacity-wait-ms <n>] [--max-capacity-pauses <n>]",
    "  aios dashboard [--root <path>] [--out <file>]",
    "",
    "The run command runs one Task through each assigned Role until it is",
    "done, blocked, waiting for Worker capacity, or halted by an error.",
    "",
    "The dashboard command generates a self-contained HTML overview of every",
    "Task's lifecycle position and evidence (default dashboard.html at the",
    "repository root); it is a read-only, one-shot pass and never modifies",
    "anything under .aios/.",
    "",
    "Exit codes: run: 0 done, 1 halted, 2 blocked, 64 usage error, 75 waiting.",
    "            dashboard: 0 written, 64 usage error.",
  ].join("\n");
}

function parseRunArguments(rest) {
  if (rest.length < 1) {
    throw new Error(usage());
  }
  const options = {
    help: false,
    command: "run",
    taskId: rest[0],
    root: process.cwd(),
    assignments: null,
    timeoutMs: 300_000,
    waitForCapacity: false,
    maxCapacityWaitMs: 604_800_000,
    maxCapacityPauses: 8,
  };
  for (let index = 1; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--wait-for-capacity") {
      options.waitForCapacity = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--root") {
      options.root = path.resolve(value);
    } else if (flag === "--assignments") {
      options.assignments = path.resolve(value);
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
    } else if (flag === "--max-capacity-wait-ms") {
      options.maxCapacityWaitMs = Number(value);
      if (!Number.isInteger(options.maxCapacityWaitMs) || options.maxCapacityWaitMs <= 0) {
        throw new Error("--max-capacity-wait-ms must be a positive integer");
      }
    } else if (flag === "--max-capacity-pauses") {
      options.maxCapacityPauses = Number(value);
      if (!Number.isInteger(options.maxCapacityPauses) || options.maxCapacityPauses <= 0) {
        throw new Error("--max-capacity-pauses must be a positive integer");
      }
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
    index += 1;
  }
  options.assignments ??= path.join(options.root, ".aios", "assignments.json");
  return options;
}

function parseDashboardArguments(rest) {
  const options = {
    help: false,
    command: "dashboard",
    root: process.cwd(),
    out: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--root") {
      options.root = path.resolve(value);
    } else if (flag === "--out") {
      options.out = path.resolve(value);
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
    index += 1;
  }
  options.out ??= path.join(options.root, "dashboard.html");
  return options;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const [command, ...rest] = argv;
  if (command === "run") {
    return parseRunArguments(rest);
  }
  if (command === "dashboard") {
    return parseDashboardArguments(rest);
  }
  throw new Error(usage());
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error.message);
    return 64;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.command === "dashboard") {
    const writtenPath = await writeDashboard({ root: options.root, out: options.out });
    console.log(writtenPath);
    return 0;
  }

  const assignments = new FileAssignmentResolver(options.assignments, {
    cwd: options.root,
    timeoutMs: options.timeoutMs,
  });
  const engine = new LoopEngine({ root: options.root, assignments });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.waitForCapacity) {
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
  }
  let outcome;
  try {
    outcome = await engine.run(options.taskId, {
      waitForCapacity: options.waitForCapacity,
      maxCapacityWaitMs: options.maxCapacityWaitMs,
      maxCapacityPauses: options.maxCapacityPauses,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  const report = {
    kind: outcome.kind,
    task: outcome.task?.metadata.id ?? options.taskId,
    state: outcome.task?.metadata.state ?? null,
    reason: outcome.reason ?? null,
  };
  if (outcome.kind === "waiting") {
    report.retry_at = outcome.retryAt;
  }
  console.log(JSON.stringify(report));
  if (outcome.kind === "done") {
    return 0;
  }
  if (outcome.kind === "blocked") {
    return 2;
  }
  return outcome.kind === "waiting" ? 75 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
