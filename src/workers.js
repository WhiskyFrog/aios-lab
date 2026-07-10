import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { roleForState } from "./contracts.js";

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

function terminateProcessTree(child) {
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

function validateCommand(command, role) {
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
  constructor(command, { cwd, timeoutMs = 300_000, outputLimit = 1_048_576 } = {}) {
    this.command = validateCommand(command, "command");
    this.cwd = path.resolve(cwd ?? process.cwd());
    this.timeoutMs = timeoutMs;
    this.outputLimit = outputLimit;
  }

  async execute(task) {
    const role = roleForState(task.metadata.state);
    if (role === null) {
      throw new WorkerError(`Task state ${task.metadata.state} has no active Role`);
    }
    const [executable, ...args] = this.command;
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let exceededLimit = false;
      let terminationStarted = false;
      let termination = Promise.resolve();

      const child = spawn(executable, args, {
        cwd: this.cwd,
        env: {
          ...process.env,
          AIOS_TASK_ID: task.metadata.id,
          AIOS_ROLE: role,
        },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

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
        reject(new WorkerError(`Unable to start Worker: ${error.message}`, { cause: error }));
      });

      child.once("close", async (code, signal) => {
        clearTimeout(timer);
        await termination;
        if (timedOut) {
          reject(new WorkerError(`Worker timed out after ${this.timeoutMs} ms`));
          return;
        }
        if (exceededLimit) {
          reject(new WorkerError("Worker output exceeded the configured limit"));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim();
          reject(
            new WorkerError(
              `Worker exited with code ${String(code)}${signal ? ` (${signal})` : ""}${
                detail ? `: ${detail}` : ""
              }`,
            ),
          );
          return;
        }

        const output = stdout.trim();
        if (output.length === 0) {
          reject(new WorkerError("Worker returned an empty stdout Result"));
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(new WorkerError("Worker stdout must be exactly one JSON Result", {
            cause: error,
          }));
        }
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
  constructor(configPath, { cwd, timeoutMs = 300_000 } = {}) {
    this.configPath = path.resolve(configPath);
    this.cwd = path.resolve(cwd ?? path.dirname(this.configPath));
    this.timeoutMs = timeoutMs;
  }

  async resolve(role) {
    if (!ROLES.has(role)) {
      throw new AssignmentError(`Unknown Role ${role}`);
    }

    let config;
    try {
      config = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch (error) {
      throw new AssignmentError(
        `Unable to read Assignment config ${this.configPath}`,
        { cause: error },
      );
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
    });
  }
}
