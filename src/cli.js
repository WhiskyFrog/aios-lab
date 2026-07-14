#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeDashboard } from "./dashboard.js";
import { LoopEngine } from "./engine.js";
import {
  adoptPlan,
  PlanAdoptionError,
  PlanValidationError,
} from "./plans.js";
import { runProgression, STOP_REASONS } from "./progression.js";
import { FileAssignmentResolver } from "./workers.js";

const PROGRESS_EXIT_CODES = Object.freeze({
  [STOP_REASONS.PLAN_COMPLETE]: 0,
  [STOP_REASONS.AWAITING_APPROVAL]: 3,
  [STOP_REASONS.BLOCKED_REJECTED]: 4,
  [STOP_REASONS.BLOCKED_RETRY_EXHAUSTED]: 4,
  [STOP_REASONS.CAPACITY_WAIT]: 5,
  [STOP_REASONS.CANCELLED]: 6,
  [STOP_REASONS.WORKER_FAILURE]: 7,
  [STOP_REASONS.INVALID_DOCUMENT]: 7,
  [STOP_REASONS.CONFLICT]: 7,
});

function usage() {
  return [
    "Usage:",
    "  aios run <task-id> [--root <path>] [--assignments <path>] [--timeout-ms <n>]",
    "       [--wait-for-capacity] [--max-capacity-wait-ms <n>] [--max-capacity-pauses <n>]",
    "  aios progress <plan-dir> [--root <path>] [--assignments <path>] [--timeout-ms <n>]",
    "       [--wait-for-capacity] [--max-capacity-wait-ms <n>] [--max-capacity-pauses <n>]",
    "  aios dashboard [--root <path>] [--out <file>]",
    "  aios adopt <plan-dir> [--root <path>] [--check]",
    "",
    "The run command runs one Task through each assigned Role until it is",
    "done, blocked, waiting for Worker capacity, or halted by an error.",
    "",
    "The progress command drives an adopted plan's Tasks forward in Execution",
    "Order, running each one through the same loop as run, until every Task",
    "is done or one of them stops for a human; it reports the completed",
    "Tasks, the stop reason, and the exact operator action to take next.",
    "",
    "The dashboard command generates a self-contained HTML overview of every",
    "Task's lifecycle position and evidence (default dashboard.html at the",
    "repository root); it is a read-only, one-shot pass and never modifies",
    "anything under .aios/.",
    "",
    "The adopt command validates a reviewed plan and atomically materializes",
    "its proposals as sequential Tasks. --check performs no writes.",
    "",
    "Exit codes: run: 0 done, 1 halted, 2 blocked, 64 usage error, 75 waiting.",
    "            progress: 0 plan complete, 3 awaiting approval, 4 blocked,",
    "                      5 capacity wait, 6 cancelled, 7 halted, 64 usage error.",
    "            dashboard: 0 written, 64 usage error.",
    "            adopt: 0 checked/adopted, 1 validation failure, 64 usage error.",
  ].join("\n");
}

// Applies the engine option flags run and progress share, with identical
// defaults, validation, and error messages for both subcommands.
function parseEngineOptions(rest, options) {
  for (let index = 0; index < rest.length; index += 1) {
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

function engineOptionDefaults(command) {
  return {
    help: false,
    command,
    root: process.cwd(),
    assignments: null,
    timeoutMs: 300_000,
    waitForCapacity: false,
    maxCapacityWaitMs: 604_800_000,
    maxCapacityPauses: 8,
  };
}

function parseRunArguments(rest) {
  if (rest.length < 1) {
    throw new Error(usage());
  }
  const options = { ...engineOptionDefaults("run"), taskId: rest[0] };
  return parseEngineOptions(rest.slice(1), options);
}

function parseProgressArguments(rest) {
  if (rest.length < 1 || rest[0].startsWith("--")) {
    throw new Error(usage());
  }
  const options = parseEngineOptions(rest.slice(1), {
    ...engineOptionDefaults("progress"),
    planArgument: rest[0],
    planDirectory: null,
  });
  options.planDirectory = path.isAbsolute(options.planArgument)
    ? path.resolve(options.planArgument)
    : path.resolve(options.root, options.planArgument);
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

function parseAdoptArguments(rest) {
  if (rest.length < 1 || rest[0].startsWith("--")) {
    throw new Error(usage());
  }
  const options = {
    help: false,
    command: "adopt",
    planArgument: rest[0],
    planDirectory: null,
    root: process.cwd(),
    checkOnly: false,
  };
  for (let index = 1; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--check") {
      options.checkOnly = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--root") {
      options.root = path.resolve(value);
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
    index += 1;
  }
  options.planDirectory = path.isAbsolute(options.planArgument)
    ? path.resolve(options.planArgument)
    : path.resolve(options.root, options.planArgument);
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
  if (command === "progress") {
    return parseProgressArguments(rest);
  }
  if (command === "dashboard") {
    return parseDashboardArguments(rest);
  }
  if (command === "adopt") {
    return parseAdoptArguments(rest);
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

  if (options.command === "adopt") {
    try {
      const result = await adoptPlan({
        root: options.root,
        planDirectory: options.planDirectory,
        checkOnly: options.checkOnly,
      });
      console.log(JSON.stringify(result));
      return 0;
    } catch (error) {
      if (error instanceof PlanValidationError || error instanceof PlanAdoptionError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }

  if (options.command === "progress") {
    const assignments = new FileAssignmentResolver(options.assignments, {
      cwd: options.root,
      timeoutMs: options.timeoutMs,
    });
    const engine = new LoopEngine({ root: options.root, assignments });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let outcome;
    try {
      outcome = await runProgression({
        root: options.root,
        planDirectory: options.planDirectory,
        engine,
        runOptions: {
          waitForCapacity: options.waitForCapacity,
          maxCapacityWaitMs: options.maxCapacityWaitMs,
          maxCapacityPauses: options.maxCapacityPauses,
          signal: controller.signal,
        },
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    console.log(
      JSON.stringify({
        plan: outcome.plan,
        completed: outcome.completed,
        complete: outcome.stopReason === STOP_REASONS.PLAN_COMPLETE,
        task: outcome.task,
        stop_reason: outcome.stopReason,
        action: outcome.action,
      }),
    );
    return PROGRESS_EXIT_CODES[outcome.stopReason];
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
