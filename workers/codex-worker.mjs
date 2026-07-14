#!/usr/bin/env node
// OpenAI Codex worker adapter for the AIOS Loop Engine.
//
// Contract (see .aios/results/README.md): the engine pipes the Task document
// to stdin, sets AIOS_TASK_ID and AIOS_ROLE, and expects exactly one
// aios.worker-execution/v1 JSON object on stdout. This adapter runs one
// non-interactive `codex exec --json` session for the Role, interprets its
// final message with the shared extraction and validation rules, and reports
// public thread and usage telemetry. On a failed turn, the adapter asks the
// same Codex launcher's app-server for structured turn-error and rate-limit
// evidence. It defers only a corroborated usageLimitExceeded turn with a
// provider-supplied future reset; human-readable error prose is never parsed.
//
// Usage in an Assignment: ["node", "workers/codex-worker.mjs", "<codex-cli...>"]
// The trailing argv tokens (or AIOS_CODEX_CLI) name the Codex launcher: a
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
  isObject,
  nonEmptyString,
  readStdin,
  rolePrompt,
  validatePayload,
  WorkerFailure,
} from "./worker-shared.mjs";
import { queryCodexCapacity } from "./codex-capacity.mjs";

const SANDBOX_BY_ROLE = {
  implementer: "workspace-write",
  reviewer: "read-only",
  approver: "read-only",
};

export function sandboxForRole(role) {
  return SANDBOX_BY_ROLE[role] ?? null;
}

export function launchCommand(argvTail, environment = process.env) {
  if (Array.isArray(argvTail) && argvTail.length > 0) {
    return argvTail;
  }
  if (nonEmptyString(environment.AIOS_CODEX_CLI)) {
    return [environment.AIOS_CODEX_CLI];
  }
  return ["codex"];
}

export function sessionArguments(
  role,
  prompt,
  outputFile,
  model,
  continuation = null,
) {
  const sandbox = sandboxForRole(role);
  const args = [
    "exec",
    "--sandbox",
    sandbox,
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    outputFile,
  ];
  if (nonEmptyString(model)) {
    args.push("--model", model);
  }
  if (nonEmptyString(continuation)) {
    args.push("resume", continuation, prompt);
  } else {
    args.push(prompt);
  }
  return args;
}

// Compatibility name retained for callers that construct a fresh session.
export function execArguments(role, prompt, outputFile, model) {
  return sessionArguments(role, prompt, outputFile, model);
}

export function runCodex(command, args) {
  const [executable, ...leadingArgs] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...leadingArgs, ...args], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", (error) =>
      reject(new Error(`unable to start ${executable}: ${error.message}`)),
    );
    child.once("close", (code) => resolve({ stdout, exitCode: code }));
  });
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Codex reports cached_input_tokens as a subset of input_tokens. The ledger's
// Claude-shaped fields are disjoint, so input_tokens stores only the uncached
// remainder and cache_read_input_tokens stores the cached subset.
export function sanitizeCodexUsage(value) {
  if (!isObject(value)) {
    return null;
  }
  const totalInput = finiteNonNegative(value.input_tokens) ? value.input_tokens : 0;
  const cachedInput = finiteNonNegative(value.cached_input_tokens)
    ? Math.min(value.cached_input_tokens, totalInput)
    : 0;
  return {
    input_tokens: totalInput - cachedInput,
    output_tokens: finiteNonNegative(value.output_tokens) ? value.output_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedInput,
  };
}

// Parse the public NDJSON emitted by `codex exec --json`. Unknown typed events
// are tolerated for forward compatibility; malformed records and conflicting
// terminal events are rejected rather than guessed around.
export function parseCodexStream(text) {
  if (typeof text !== "string") {
    throw new Error("Codex session stdout must be a string");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  let threadId = null;
  let completed = null;
  let failed = null;
  let streamError = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) {
      throw new Error(`Codex session stdout line ${index + 1} is blank`);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Codex session stdout line ${index + 1} is not valid JSON`);
    }
    if (!isObject(event) || !nonEmptyString(event.type)) {
      throw new Error(`Codex session stdout line ${index + 1} is not a typed JSON object`);
    }
    if (event.type === "thread.started") {
      if (threadId !== null || !nonEmptyString(event.thread_id)) {
        throw new Error("Codex session stdout has an invalid or duplicate thread.started event");
      }
      threadId = event.thread_id;
    } else if (event.type === "turn.completed") {
      if (completed !== null) {
        throw new Error("Codex session stdout contains multiple turn.completed events");
      }
      completed = event;
    } else if (event.type === "turn.failed") {
      if (failed !== null) {
        throw new Error("Codex session stdout contains multiple turn.failed events");
      }
      failed = event;
    } else if (event.type === "error") {
      streamError = event;
    }
  }
  if (threadId === null) {
    throw new Error("Codex session did not report a thread_id");
  }
  if (completed !== null && failed !== null) {
    throw new Error("Codex session stdout contains both completed and failed turns");
  }
  return { thread_id: threadId, completed, failed, stream_error: streamError };
}

function resultEnvelope(taskId, role, payload) {
  return "failure_reason" in payload
    ? {
        schema: "aios.result/v1",
        task: taskId,
        role,
        status: "failure",
        payload: {
          reason: payload.failure_reason,
          ...(payload.failure_kind === undefined
            ? {}
            : { failure_kind: payload.failure_kind }),
        },
      }
    : { schema: "aios.result/v1", task: taskId, role, status: "success", payload };
}

function failureEnvelope(taskId, role, reason) {
  return {
    schema: "aios.result/v1",
    task: taskId,
    role,
    status: "failure",
    payload: { reason },
  };
}

// Retained as a small pure helper for callers that only need legacy Result
// interpretation; the adapter entry point uses buildWorkerExecution below.
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

function reportedError(parsed) {
  if (nonEmptyString(parsed.failed?.error?.message)) {
    return parsed.failed.error.message;
  }
  if (nonEmptyString(parsed.stream_error?.message)) {
    return parsed.stream_error.message;
  }
  return null;
}

export function buildWorkerExecution({
  stdout,
  exitCode,
  reply,
  taskId,
  role,
  model,
  startedAt,
  observedAt,
  expectedSessionId = null,
  capacityEvidence = null,
}) {
  const parsed = parseCodexStream(stdout);
  const usage = sanitizeCodexUsage(parsed.completed?.usage);
  const execution = (result, outcome, capacity = null, deferred = null) => ({
    schema: "aios.worker-execution/v1",
    result,
    deferred,
    session: {
      id: parsed.thread_id,
      task: taskId,
      role,
      model: nonEmptyString(model) ? model : null,
      started_at: startedAt,
      observed_at: observedAt,
      outcome,
      usage,
      cost_usd: null,
      capacity,
    },
  });
  const failed = (reason) => execution(failureEnvelope(taskId, role, reason), "failed");

  if (expectedSessionId !== null && parsed.thread_id !== expectedSessionId) {
    return failed(
      `Codex resumed session ${parsed.thread_id} instead of expected session ${expectedSessionId}`,
    );
  }
  if (
    parsed.failed !== null &&
    isObject(capacityEvidence) &&
    nonEmptyString(capacityEvidence.retry_at) &&
    isObject(capacityEvidence.capacity)
  ) {
    return execution(
      null,
      "capacity_deferred",
      capacityEvidence.capacity,
      {
        kind: "capacity",
        retry_at: capacityEvidence.retry_at,
        continuation: parsed.thread_id,
      },
    );
  }
  const sessionError = reportedError(parsed);
  if (sessionError !== null) {
    return failed(`Codex session reported an error: ${sessionError.slice(0, 400)}`);
  }
  if (exitCode !== 0) {
    return failed(`Codex session exited with code ${String(exitCode)}`);
  }
  if (parsed.completed === null) {
    return failed("Codex session returned an unexpected output structure");
  }
  if (!nonEmptyString(reply)) {
    return failed("Codex session produced no final message");
  }
  const payload = extractPayload(reply);
  const problem = validatePayload(role, payload);
  if (problem !== null) {
    return failed(`unusable ${role} reply (${problem}): ${reply.slice(0, 400)}`);
  }
  const result = resultEnvelope(taskId, role, payload);
  return execution(result, result.status === "failure" ? "failed" : "completed");
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
  const continuation = process.env.AIOS_WORKER_CONTINUATION;
  process.stderr.write(`codex-worker: starting ${role} session for ${taskId}\n`);

  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-codex-"));
  const outputFile = path.join(directory, "last-message.txt");
  try {
    const startedAt = new Date().toISOString();
    let sessionRun;
    try {
      sessionRun = await runCodex(
        command,
        sessionArguments(role, prompt, outputFile, model, continuation),
      );
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

    let execution;
    try {
      let capacityEvidence = null;
      const parsed = parseCodexStream(sessionRun.stdout);
      if (parsed.failed !== null) {
        try {
          capacityEvidence = await queryCodexCapacity({
            command,
            threadId: parsed.thread_id,
            environment: process.env,
            cwd: process.cwd(),
          });
        } catch (error) {
          process.stderr.write(
            `codex-worker: structured capacity probe unavailable: ${error.message}\n`,
          );
        }
      }
      execution = buildWorkerExecution({
        stdout: sessionRun.stdout,
        exitCode: sessionRun.exitCode,
        reply,
        taskId,
        role,
        model,
        startedAt,
        observedAt: new Date().toISOString(),
        expectedSessionId: nonEmptyString(continuation) ? continuation : null,
        capacityEvidence,
      });
    } catch (error) {
      fail(error.message);
    }
    process.stdout.write(JSON.stringify(execution));
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
