import { spawn } from "node:child_process";
import process from "node:process";

import { isObject, nonEmptyString } from "./worker-shared.mjs";

const APP_SERVER_TIMEOUT_MS = 10_000;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_credit_limit_reached",
  "workspace_usage_limit_reached",
  "workspace_per_user_limit_reached",
]);

function responseError(response, label) {
  if (!isObject(response)) {
    return `${label} returned no response`;
  }
  if (isObject(response.error)) {
    const code = Number.isInteger(response.error.code)
      ? ` (${String(response.error.code)})`
      : "";
    const message = nonEmptyString(response.error.message)
      ? response.error.message.slice(0, 300)
      : "unknown protocol error";
    return `${label} failed${code}: ${message}`;
  }
  if (!isObject(response.result)) {
    return `${label} returned no result`;
  }
  return null;
}

function codexRateLimitSnapshot(result) {
  if (!isObject(result)) {
    return null;
  }
  const keyed = result.rateLimitsByLimitId;
  if (isObject(keyed) && isObject(keyed.codex)) {
    return keyed.codex;
  }
  return isObject(result.rateLimits) && result.rateLimits.limitId === "codex"
    ? result.rateLimits
    : null;
}

function unixReset(window, nowMilliseconds) {
  if (!isObject(window) || typeof window.usedPercent !== "number") {
    return null;
  }
  if (!Number.isFinite(window.usedPercent) || window.usedPercent < 100) {
    return null;
  }
  if (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0) {
    return { exhausted: true, future: false, milliseconds: null };
  }
  const milliseconds = window.resetsAt * 1000;
  return {
    exhausted: true,
    future: Number.isSafeInteger(milliseconds) && milliseconds > nowMilliseconds,
    milliseconds,
  };
}

// Convert only corroborated app-server evidence into the engine's capacity
// shape. Human-readable error text is deliberately ignored.
export function capacityFromAppServer(
  threadId,
  threadResumeResponse,
  rateLimitsResponse,
  nowMilliseconds = Date.now(),
) {
  if (!nonEmptyString(threadId) || !Number.isFinite(nowMilliseconds)) {
    return null;
  }
  if (
    responseError(threadResumeResponse, "thread/resume") !== null ||
    responseError(rateLimitsResponse, "account/rateLimits/read") !== null
  ) {
    return null;
  }

  const resumed = threadResumeResponse.result;
  if (resumed.thread?.id !== threadId) {
    return null;
  }
  const turns = resumed.initialTurnsPage?.data;
  const latest = Array.isArray(turns) ? turns[0] : null;
  if (
    !isObject(latest) ||
    latest.status !== "failed" ||
    latest.error?.codexErrorInfo !== "usageLimitExceeded"
  ) {
    return null;
  }

  const snapshot = codexRateLimitSnapshot(rateLimitsResponse.result);
  if (
    !isObject(snapshot) ||
    snapshot.limitId !== "codex" ||
    !REACHED_TYPES.has(snapshot.rateLimitReachedType)
  ) {
    return null;
  }

  const resets = [unixReset(snapshot.primary, nowMilliseconds), unixReset(snapshot.secondary, nowMilliseconds)]
    .filter((entry) => entry?.exhausted === true);
  if (resets.length === 0 || resets.some((entry) => !entry.future)) {
    return null;
  }
  const resetMilliseconds = Math.max(...resets.map((entry) => entry.milliseconds));
  const reset = new Date(resetMilliseconds).toISOString();
  return {
    retry_at: reset,
    capacity: { status: "rejected", utilization: 1, resets_at: reset },
  };
}

function appServerRequests(threadId) {
  return {
    initialize: {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "aios-codex-worker", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
    },
    initialized: { method: "initialized" },
    resume: {
      id: 2,
      method: "thread/resume",
      params: {
        threadId,
        excludeTurns: true,
        initialTurnsPage: {
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      },
    },
    rateLimits: { id: 3, method: "account/rateLimits/read", params: null },
  };
}

export function queryCodexCapacity({
  command,
  threadId,
  environment = process.env,
  cwd = process.cwd(),
  nowMilliseconds = Date.now(),
  timeoutMs = APP_SERVER_TIMEOUT_MS,
}) {
  if (!Array.isArray(command) || command.length === 0 || !nonEmptyString(command[0])) {
    return Promise.reject(new Error("Codex app-server command is empty"));
  }
  if (!nonEmptyString(threadId)) {
    return Promise.reject(new Error("Codex app-server query requires a thread id"));
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Codex app-server timeout must be a positive integer"));
  }

  const [executable, ...leadingArgs] = command;
  const requests = appServerRequests(threadId);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...leadingArgs, "app-server", "--stdio"], {
      cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let resumeResponse = null;
    let rateLimitsResponse = null;

    const stop = () => {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    const finish = (error, value = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stop();
      if (error !== null) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const maybeFinish = () => {
      if (resumeResponse === null || rateLimitsResponse === null) {
        return;
      }
      const resumeProblem = responseError(resumeResponse, "thread/resume");
      const rateProblem = responseError(rateLimitsResponse, "account/rateLimits/read");
      if (resumeProblem !== null || rateProblem !== null) {
        finish(new Error(resumeProblem ?? rateProblem));
        return;
      }
      finish(
        null,
        capacityFromAppServer(
          threadId,
          resumeResponse,
          rateLimitsResponse,
          nowMilliseconds,
        ),
      );
    };
    const timer = setTimeout(() => {
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 300)}` : "";
      finish(new Error(`Codex app-server query timed out after ${String(timeoutMs)}ms${detail}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) {
        stderr += chunk;
      }
    });
    child.stdout.on("data", (chunk) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_PROTOCOL_BYTES) {
        finish(new Error("Codex app-server response exceeded the 1 MiB limit"));
        return;
      }
      stdout += chunk;
      while (stdout.includes("\n") && !settled) {
        const newline = stdout.indexOf("\n");
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Codex app-server returned malformed JSON"));
          return;
        }
        if (!isObject(message)) {
          continue;
        }
        if (message.id === 1) {
          const problem = responseError(message, "initialize");
          if (problem !== null) {
            finish(new Error(problem));
            return;
          }
          send(requests.initialized);
          send(requests.resume);
          send(requests.rateLimits);
        } else if (message.id === 2) {
          resumeResponse = message;
          maybeFinish();
        } else if (message.id === 3) {
          rateLimitsResponse = message;
          maybeFinish();
        }
      }
    });
    child.once("error", (error) => {
      finish(new Error(`unable to start Codex app-server: ${error.message}`));
    });
    child.once("close", (code) => {
      if (!settled) {
        const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 300)}` : "";
        finish(
          new Error(`Codex app-server exited before replying (code ${String(code)})${detail}`),
        );
      }
    });
    send(requests.initialize);
  });
}
