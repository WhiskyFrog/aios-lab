import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { roleForState } from "./contracts.js";
import {
  SessionLedger,
  WORKER_EXECUTION_SCHEMA,
  validateWorkerExecution,
} from "./sessions.js";

const ROLES = new Set(["implementer", "reviewer", "approver"]);

export class AssignmentError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "AssignmentError";
  }
}

export class WorkerError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "WorkerError";
  }
}

export class CapacityDeferredError extends WorkerError {
  constructor(message, { retryAt, continuation, sessionId = null }) {
    super(message);
    this.name = "CapacityDeferredError";
    this.retryAt = retryAt;
    this.continuation = continuation;
    this.sessionId = sessionId;
  }
}

export class WorkerTimeoutError extends WorkerError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "WorkerTimeoutError";
  }
}

export class ProviderFailureError extends WorkerError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "ProviderFailureError";
  }
}

export function terminateProcessTree(child) {
  if (!child.pid) {
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    const taskkill = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          clearTimeout(fallback);
          resolve();
        }
      };
      const killer = spawn(
        taskkill,
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      const fallback = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 2_000);
      killer.once("error", () => {
        child.kill("SIGKILL");
        finish();
      });
      killer.once("close", (code) => {
        if (code !== 0) {
          child.kill("SIGKILL");
        }
        finish();
      });
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
}

export function workerEnvironment(environment, taskId, role, continuation = null) {
  const env = {
    ...environment,
    AIOS_TASK_ID: taskId,
    AIOS_ROLE: role,
  };
  delete env.AIOS_WORKER_CONTINUATION;
  if (continuation !== null) {
    env.AIOS_WORKER_CONTINUATION = continuation;
  }
  return env;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function validateCommand(command, role) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new AssignmentError(
      `Assignment for ${role} must be a non-empty argv string array`,
    );
  }
  return command;
}

export class CommandWorker {
  constructor(
    command,
    { cwd, timeoutMs = 300_000, outputLimit = 1_048_576, ledger = null } = {},
  ) {
    this.command = validateCommand(command, "command");
    this.cwd = path.resolve(cwd ?? process.cwd());
    this.timeoutMs = timeoutMs;
    this.outputLimit = outputLimit;
    this.ledger = ledger;
    this.lastExecution = null;
  }

  async execute(task, { continuation = null, signal = undefined } = {}) {
    this.lastExecution = null;
    const role = roleForState(task.metadata.state);
    if (role === null) {
      throw new WorkerError(`Task state ${task.metadata.state} has no active Role`);
    }
    if (
      continuation !== null &&
      (typeof continuation !== "string" || continuation.trim().length === 0)
    ) {
      throw new WorkerError("Worker continuation must be a non-empty string");
    }
    const [executable, ...args] = this.command;
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let exceededLimit = false;
      let terminationStarted = false;
      let termination = Promise.resolve();

      const env = workerEnvironment(
        process.env,
        task.metadata.id,
        role,
        continuation,
      );

      const child = spawn(executable, args, {
        cwd: this.cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const abort = () => {
        aborted = true;
        if (!terminationStarted) {
          terminationStarted = true;
          termination = terminateProcessTree(child);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > this.outputLimit && !terminationStarted) {
          exceededLimit = true;
          terminationStarted = true;
          termination = terminateProcessTree(child);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > this.outputLimit && !terminationStarted) {
          exceededLimit = true;
          terminationStarted = true;
          termination = terminateProcessTree(child);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (!terminationStarted) {
          terminationStarted = true;
          termination = terminateProcessTree(child);
        }
      }, this.timeoutMs);

      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(
          new ProviderFailureError(`Unable to start Worker: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.once("close", async (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await termination;
        if (aborted) {
          reject(new WorkerError("Worker execution was cancelled"));
          return;
        }
        if (timedOut) {
          reject(
            new WorkerTimeoutError(`Worker timed out after ${this.timeoutMs} ms`),
          );
          return;
        }
        if (exceededLimit) {
          reject(
            new ProviderFailureError(
              "Worker output exceeded the configured limit",
            ),
          );
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim();
          reject(
            new ProviderFailureError(
              `Worker exited with code ${String(code)}${
                exitSignal ? ` (${exitSignal})` : ""
              }${detail ? `: ${detail}` : ""}`,
            ),
          );
          return;
        }

        const output = stdout.trim();
        if (output.length === 0) {
          reject(
            new ProviderFailureError("Worker returned an empty stdout Result"),
          );
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch (error) {
          reject(
            new ProviderFailureError(
              "Worker stdout must be exactly one JSON Result",
              { cause: error },
            ),
          );
          return;
        }

        if (parsed?.schema !== WORKER_EXECUTION_SCHEMA) {
          resolve(parsed);
          return;
        }

        let execution;
        try {
          execution = validateWorkerExecution(parsed);
          if (
            execution.session.task !== task.metadata.id ||
            execution.session.role !== role
          ) {
            throw new Error(
              "Worker execution session does not match the active Task and Role",
            );
          }
          if (this.ledger !== null) {
            await this.ledger.record(execution.session);
          }
        } catch (error) {
          reject(
            new ProviderFailureError(
              `Invalid Worker execution envelope: ${error.message}`,
              { cause: error },
            ),
          );
          return;
        }

        this.lastExecution = Object.freeze({
          sessionId: execution.session.id,
          model: execution.session.model,
          outcome: execution.session.outcome,
        });

        if (execution.deferred !== null) {
          reject(
            new CapacityDeferredError(
              `Worker capacity is unavailable until ${execution.deferred.retry_at}`,
              {
                retryAt: execution.deferred.retry_at,
                continuation: execution.deferred.continuation,
                sessionId: execution.session.id,
              },
            ),
          );
          return;
        }
        resolve(execution.result);
      });

      child.stdin.on("error", () => {});
      child.stdin.end(task.raw, "utf8");
    });
  }
}

export class StaticAssignmentResolver {
  constructor(assignments = {}) {
    this.assignments = new Map(Object.entries(assignments));
  }

  set(role, worker) {
    this.assignments.set(role, worker);
  }

  delete(role) {
    this.assignments.delete(role);
  }

  async resolve(role) {
    const worker = this.assignments.get(role);
    if (!worker || typeof worker.execute !== "function") {
      throw new AssignmentError(`No Worker is assigned to Role ${role}`);
    }
    return worker;
  }
}

export class FileAssignmentResolver {
  constructor(configPath, { cwd, timeoutMs = 300_000, ledger = null } = {}) {
    this.configPath = path.resolve(configPath);
    this.cwd = path.resolve(cwd ?? path.dirname(this.configPath));
    this.timeoutMs = timeoutMs;
    this.ledger =
      ledger ??
      new SessionLedger(path.join(this.cwd, ".aios", "runtime", "sessions.json"));
    this.routedResolver = null;
    this.preparedConfig = null;
  }

  async policyRevision() {
    const { loadExecutionConfig } = await import("./routing.js");
    const loaded = await loadExecutionConfig(this.configPath);
    this.preparedConfig = loaded;
    if (loaded.kind !== "routing") {
      return null;
    }
    const { routingPolicyRevision } = await import("./routing-dispatch.js");
    return routingPolicyRevision(loaded.config);
  }

  async resolve(role, context = undefined) {
    if (!ROLES.has(role)) {
      throw new AssignmentError(`Unknown Role ${role}`);
    }

    let config;
    if (this.preparedConfig !== null) {
      config = this.preparedConfig.config;
      this.preparedConfig = null;
    } else {
      try {
        config = JSON.parse(await readFile(this.configPath, "utf8"));
      } catch (error) {
        throw new AssignmentError(
          `Unable to read Assignment config ${this.configPath}`,
          { cause: error },
        );
      }
    }
    if (config?.schema === "aios.routing/v1") {
      if (role === "approver") {
        return new CommandWorker([process.execPath, "workers/human-approver.mjs"], {
          cwd: this.cwd,
          timeoutMs: this.timeoutMs,
          ledger: this.ledger,
        });
      }
      const { RoutedAssignmentResolver } = await import("./routing-dispatch.js");
      this.routedResolver ??= new RoutedAssignmentResolver(this.configPath, {
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        ledger: this.ledger,
      });
      return this.routedResolver.resolve(role, context);
    }
    if (!hasExactKeys(config, ["schema", "assignments"])) {
      throw new AssignmentError(
        "Assignment config must contain exactly schema and assignments",
      );
    }
    if (config.schema !== "aios.assignments/v1" || !isObject(config.assignments)) {
      throw new AssignmentError("Invalid aios.assignments/v1 config");
    }
    for (const configuredRole of Object.keys(config.assignments)) {
      if (!ROLES.has(configuredRole)) {
        throw new AssignmentError(`Assignment config has unknown Role ${configuredRole}`);
      }
    }

    const command = validateCommand(config.assignments[role], role);
    return new CommandWorker(command, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      ledger: this.ledger,
    });
  }
}
