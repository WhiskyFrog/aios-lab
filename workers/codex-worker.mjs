#!/usr/bin/env node
// OpenAI Codex worker adapter for the AIOS Loop Engine.
//
// Contract (see .aios/results/README.md): the engine pipes the Task document
// to stdin, sets AIOS_TASK_ID and AIOS_ROLE, and expects exactly one
// aios.result/v1 JSON object on stdout. This adapter runs one
// non-interactive `codex exec` session for the Role and interprets its final
// message with the same extraction and validation rules the Claude adapter
// uses (see worker-shared.mjs), so the two adapters are interchangeable
// through Assignment configuration alone. Codex has no capacity-deferral
// signal in scope here, so this adapter always emits a bare Result v1, which
// the command transport accepts unchanged.
//
// Usage in an Assignment: ["node", "workers/codex-worker.mjs", "<codex-cli...>"]
// The trailing argv tokens (or AIOS_CODEX_CLI) name the Codex launcher — a
// native binary path, or "node" followed by the portable cli.js path.
// AIOS_CODEX_MODEL overrides the model; unset uses the CLI's configured
// default.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  extractPayload,
  fail,
  nonEmptyString,
  readStdin,
  rolePrompt,
  validatePayload,
  WorkerFailure,
} from "./worker-shared.mjs";

const SANDBOX_BY_ROLE = {
  implementer: "workspace-write",
  reviewer: "read-only",
  approver: "read-only",
};

export function sandboxForRole(role) {
  return SANDBOX_BY_ROLE[role] ?? null;
}

// Resolves the Codex launcher: the adapter's trailing argv tokens (one or
// more, so both a native binary path and a "node <cli.js>" pair work) take
// priority, then AIOS_CODEX_CLI, then a bare "codex" lookup.
export function launchCommand(argvTail, environment = process.env) {
  if (Array.isArray(argvTail) && argvTail.length > 0) {
    return argvTail;
  }
  if (nonEmptyString(environment.AIOS_CODEX_CLI)) {
    return [environment.AIOS_CODEX_CLI];
  }
  return ["codex"];
}

export function execArguments(role, prompt, outputFile, model) {
  const sandbox = sandboxForRole(role);
  const args = [
    "exec",
    "--sandbox",
    sandbox,
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
  ];
  if (nonEmptyString(model)) {
    args.push("--model", model);
  }
  args.push(prompt);
  return args;
}

export function runCodex(command, args) {
  const [executable, ...leadingArgs] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...leadingArgs, ...args], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error) =>
      reject(new Error(`unable to start ${executable}: ${error.message}`)),
    );
    child.once("close", (code) => resolve(code));
  });
}

function resultEnvelope(taskId, role, payload) {
  return Object.keys(payload).length === 1 && "failure_reason" in payload
    ? {
        schema: "aios.result/v1",
        task: taskId,
        role,
        status: "failure",
        payload: { reason: payload.failure_reason },
      }
    : { schema: "aios.result/v1", task: taskId, role, status: "success", payload };
}

// Interprets one codex exec run through the shared extraction/validation
// rules. A nonzero exit or a reply that fails validation is unusable, so it
// fails the adapter (nonzero exit, no stdout) instead of returning a Result:
// only a session that produced an interpretable reply gets a Result at all.
export function buildResult(taskId, role, exitCode, reply) {
  if (exitCode !== 0) {
    fail(`codex exec exited with code ${String(exitCode)}`);
  }
  if (!nonEmptyString(reply)) {
    fail("codex exec produced no final message");
  }
  const payload = extractPayload(reply);
  const problem = validatePayload(role, payload);
  if (problem !== null) {
    fail(`unusable ${role} reply (${problem}): ${reply.slice(0, 400)}`);
  }
  return resultEnvelope(taskId, role, payload);
}

async function main() {
  const taskId = process.env.AIOS_TASK_ID;
  const role = process.env.AIOS_ROLE;
  if (!nonEmptyString(taskId) || !nonEmptyString(role)) {
    fail("AIOS_TASK_ID and AIOS_ROLE must be set by the Loop Engine");
  }
  if (sandboxForRole(role) === null) {
    fail(`unsupported Role: ${role}`);
  }

  const taskDocument = await readStdin();
  if (taskDocument.trim().length === 0) {
    fail("expected the Task document on stdin");
  }

  const prompt = rolePrompt(role, taskDocument);
  if (prompt === null) {
    fail(`unsupported Role: ${role}`);
  }

  const command = launchCommand(process.argv.slice(2), process.env);
  const model = process.env.AIOS_CODEX_MODEL;
  process.stderr.write(`codex-worker: starting ${role} session for ${taskId}\n`);

  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-codex-"));
  const outputFile = path.join(directory, "last-message.txt");
  try {
    let exitCode;
    try {
      exitCode = await runCodex(command, execArguments(role, prompt, outputFile, model));
    } catch (error) {
      fail(error.message);
    }

    let reply = null;
    try {
      reply = await readFile(outputFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const result = buildResult(taskId, role, exitCode, reply);
    process.stdout.write(JSON.stringify(result));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      process.stderr.write(`codex-worker: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
