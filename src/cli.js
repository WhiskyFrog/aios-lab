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
    "  aios dashboard [--root <path>] [--out <file>]",
    "",
    "The run command runs one Task through each assigned Role until it is",
    "done, blocked, or halted by an execution/configuration error.",
    "",
    "The dashboard command generates a self-contained HTML overview of every",
    "Task's lifecycle position and evidence (default dashboard.html at the",
    "repository root); it is a read-only, one-shot pass and never modifies",
    "anything under .aios/.",
    "",
    "Exit codes: run — 0 done, 1 halted, 2 blocked, 64 usage error.",
    "            dashboard — 0 written, 64 usage error.",
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
  };
  for (let index = 1; index < rest.length; index += 1) {
    const flag = rest[index];
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
  const outcome = await engine.run(options.taskId);
  console.log(
    JSON.stringify({
      kind: outcome.kind,
      task: outcome.task?.metadata.id ?? options.taskId,
      state: outcome.task?.metadata.state ?? null,
      reason: outcome.reason ?? null,
    }),
  );
  return outcome.kind === "done" ? 0 : outcome.kind === "blocked" ? 2 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
