#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { LoopEngine } from "./engine.js";
import { FileAssignmentResolver } from "./workers.js";

function usage() {
  return [
    "Usage:",
    "  aios run <task-id> [--root <path>] [--assignments <path>] [--timeout-ms <n>]",
    "",
    "The command runs one Task through each assigned Role until it is done,",
    "blocked, or halted by an execution/configuration error.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  if (argv[0] !== "run" || argv.length < 2) {
    throw new Error(usage());
  }

  const options = {
    help: false,
    taskId: argv[1],
    root: process.cwd(),
    assignments: null,
    timeoutMs: 300_000,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
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

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(usage());
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
