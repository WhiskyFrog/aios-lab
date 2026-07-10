#!/usr/bin/env node
// Human approver worker for the AIOS Loop Engine.
//
// Contract (see .aios/results/README.md): the engine pipes the Task document
// to stdin, sets AIOS_TASK_ID and AIOS_ROLE, and expects exactly one
// aios.result/v1 JSON object on stdout. This worker resolves the `approver`
// Role to a human operator: it reads a decision the operator wrote to
// `.aios/approvals/<task-id>` and turns it into a Result. Until that file
// exists, it returns a failure Result naming the exact path and accepted
// contents, so the engine halts for operator recovery instead of retrying.
//
// Usage in an Assignment: ["node", "workers/human-approver.mjs"]

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DECISIONS = new Set(["approved", "rejected"]);

class WorkerFailure extends Error {}

function fail(message) {
  throw new WorkerFailure(message);
}

export function approvalFilePath(taskId, cwd = process.cwd()) {
  return path.join(cwd, ".aios", "approvals", taskId);
}

// Reads the decision file for a Task and returns either a success Result
// payload ({ decision }) or a failure Result payload ({ reason }). Never
// throws for an expected outcome (missing file, invalid content); only I/O
// errors other than "not found" propagate.
export async function readDecision(taskId, cwd = process.cwd()) {
  const filePath = approvalFilePath(taskId, cwd);
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        status: "failure",
        payload: {
          reason:
            `awaiting human decision: create ${filePath} ` +
            `containing exactly "approved" or "rejected"`,
        },
      };
    }
    throw error;
  }
  const decision = raw.trim();
  if (!DECISIONS.has(decision)) {
    return {
      status: "failure",
      payload: { reason: `invalid decision file content: "${decision}"` },
    };
  }
  return { status: "success", payload: { decision } };
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

async function main() {
  const taskId = process.env.AIOS_TASK_ID;
  const role = process.env.AIOS_ROLE;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    fail("AIOS_TASK_ID must be set by the Loop Engine");
  }
  if (role !== "approver") {
    fail(`unsupported Role: ${String(role)}`);
  }

  await readStdin();

  const { status, payload } = await readDecision(taskId);

  process.stdout.write(
    JSON.stringify({
      schema: "aios.result/v1",
      task: taskId,
      role: "approver",
      status,
      payload,
    }),
  );
}

function isEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  try {
    await main();
  } catch (error) {
    if (error instanceof WorkerFailure) {
      process.stderr.write(`human-approver: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
