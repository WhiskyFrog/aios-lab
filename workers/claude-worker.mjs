#!/usr/bin/env node
// Claude Code worker adapter for the AIOS Loop Engine.
//
// Contract (see .aios/results/README.md): the engine pipes the Task document
// to stdin, sets AIOS_TASK_ID and AIOS_ROLE, and expects exactly one
// aios.worker-execution/v1 JSON object on stdout. This adapter runs one
// non-interactive Claude Code session for the Role and translates its stream
// into either a Result or a structured capacity deferral. Structured ordinary
// failures become failure Results; unparseable output exits nonzero.
//
// Usage in an Assignment: ["node", "workers/claude-worker.mjs", "<claude-cli>"]
// The optional argument (or AIOS_CLAUDE_CLI) names the Claude executable;
// AIOS_CLAUDE_MODEL overrides the model alias (default "sonnet").

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "../src/workers.js";

const VERDICTS = new Set(["pass", "changes_requested"]);
const DECISIONS = new Set(["approved", "rejected"]);
const RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

const HARD_RULES = [
  "Hard rules:",
  "- Never create, modify, or delete anything under .aios/. The Loop Engine owns those documents.",
  "- Never run git commit, git push, or anything that rewrites git history.",
  "- Do not start servers, daemons, or background processes.",
  "- Work only inside the current working directory (the repository root).",
].join("\n");

const REPLY_RULES = (shape) =>
  [
    "When finished, reply with ONLY one JSON object - no markdown fences, no other text:",
    shape,
    'If you cannot complete the work, reply instead with: {"failure_reason":"<why>"}',
  ].join("\n");

export function rolePrompt(role, taskDocument) {
  const sections = {
    implementer: [
      "You are the Implementer Worker in an AIOS Task loop.",
      "Satisfy the Task's Acceptance Criteria within its Constraints. If a previous Review requested changes, the Task's last Attempt and the Review findings describe what must improve.",
      "Verify your work: run the test suite if one exists, otherwise demonstrate the behavior directly.",
      HARD_RULES,
      REPLY_RULES(
        '{"summary":"<what you changed or produced>","verification":"<what you checked and its outcome, or: Not run: <reason>>"}',
      ),
    ],
    reviewer: [
      "You are the Reviewer Worker in an AIOS Task loop.",
      "Evaluate the latest Attempt of this Task against every Acceptance Criterion and Constraint. Inspect the repository read-only; verify claims against the actual files rather than trusting the Attempt text.",
      "Request changes only for defects that block acceptance; record smaller observations as non-blocking notes in your findings.",
      HARD_RULES,
      REPLY_RULES(
        '{"verdict":"pass","findings":"<why>"} or {"verdict":"changes_requested","findings":"<exactly what must change>"}',
      ),
    ],
    approver: [
      "You are the Approver Worker in an AIOS Task loop.",
      "The Task passed review. Make the final approval decision based on the Task document and the repository.",
      HARD_RULES,
      REPLY_RULES('{"decision":"approved"} or {"decision":"rejected"}'),
    ],
  };
  const lines = sections[role];
  if (!lines) {
    return null;
  }
  return [...lines, "", "The complete Task document follows:", "", taskDocument].join("\n");
}

export function sessionArguments(role, prompt, model, continuation = null) {
  const base = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
  ];
  if (nonEmptyString(continuation)) {
    base.push("--resume", continuation);
  }
  if (role === "implementer") {
    // Edits are auto-accepted and Bash is allowed: the Implementer is the
    // one Role that is supposed to change the repository.
    return [...base, "--permission-mode", "acceptEdits", "--allowedTools", "Bash"];
  }
  // Reviewer/approver sessions keep the default permission mode: read-only
  // tools work, everything else is denied in non-interactive mode. npm test
  // is allowed so a Reviewer can execute the suite it is judging.
  return [...base, "--allowedTools", "Bash(npm test),Bash(npm test:*)"];
}

// A failure is reported by throwing WorkerFailure. This makes "the adapter
// cannot continue past a failure" a language-enforced fact rather than a
// convention call sites have to honor correctly: throwing unwinds the
// current call stack immediately, so nothing after a fail() call can run,
// and only the single top-level catch below ever turns a failure into the
// stderr diagnostic and nonzero exit.
class WorkerFailure extends Error {}

function fail(message) {
  throw new WorkerFailure(message);
}

// Extraction rule: scan the reply left to right for '{' characters. For each
// one, find its matching '}' by tracking brace depth while skipping over the
// contents of JSON string literals (so a brace inside a string value can't
// throw off the count), then attempt JSON.parse on that whole span. Matching
// is non-overlapping: once a span is tried, scanning resumes after it, so
// nested braces inside a successfully-parsed object are not re-considered as
// separate candidates. Every span that parses as a JSON object is a
// candidate; the reply is usable only when exactly one candidate exists.
// This accepts a reply that is the whole payload, one wrapped in markdown
// code fences (fence markers contain no braces and are simply skipped as
// prose), and one surrounded by prose, while stray prose braces are rejected
// because they either fail to parse (e.g. "{like this}") or, if they do
// parse, make the extraction ambiguous.
export function extractPayload(text) {
  const candidates = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "{") {
      index += 1;
      continue;
    }
    const end = findMatchingBrace(text, index);
    if (end === -1) {
      index += 1;
      continue;
    }
    try {
      const value = JSON.parse(text.slice(index, end + 1));
      if (isObject(value)) {
        candidates.push(value);
      }
    } catch {
      // Not valid JSON; keep scanning past it.
    }
    index = end + 1;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validatePayload(role, payload) {
  if (!isObject(payload)) {
    return "the reply is not a JSON object";
  }
  const keys = Object.keys(payload).sort();
  if (keys.length === 1 && keys[0] === "failure_reason") {
    return nonEmptyString(payload.failure_reason)
      ? null
      : "failure_reason must be a non-empty string";
  }
  if (role === "implementer") {
    if (keys.join(",") !== "summary,verification") {
      return "implementer reply must contain exactly summary and verification";
    }
    return nonEmptyString(payload.summary) && nonEmptyString(payload.verification)
      ? null
      : "summary and verification must be non-empty strings";
  }
  if (role === "reviewer") {
    if (keys.join(",") !== "findings,verdict") {
      return "reviewer reply must contain exactly verdict and findings";
    }
    if (!VERDICTS.has(payload.verdict)) {
      return "verdict must be pass or changes_requested";
    }
    return nonEmptyString(payload.findings) ? null : "findings must be a non-empty string";
  }
  if (keys.join(",") !== "decision") {
    return "approver reply must contain exactly decision";
  }
  return DECISIONS.has(payload.decision) ? null : "decision must be approved or rejected";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value) {
  return finiteNumber(value) && value >= 0;
}

function utilizationNumber(value) {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function epochSecondsToIso(value) {
  if (!finiteNumber(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sanitizeUsage(value) {
  if (!isObject(value)) {
    return null;
  }
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, nonNegativeNumber(value[field]) ? value[field] : 0]),
  );
}

function sanitizeCost(value) {
  return nonNegativeNumber(value) ? value : null;
}

// Rate-limit events are provider telemetry, not Result text. In particular,
// rejected prose in an assistant or result message is deliberately ignored.
export function parseRateLimitEvent(event) {
  if (!isObject(event) || event.type !== "rate_limit_event") {
    return null;
  }
  const info = event.rate_limit_info;
  if (
    !isObject(info) ||
    !RATE_LIMIT_STATUSES.has(info.status) ||
    !nonEmptyString(event.session_id)
  ) {
    return null;
  }

  const resetsAt = epochSecondsToIso(info.resetsAt);
  return {
    session_id: event.session_id,
    capacity: {
      status: info.status,
      utilization: utilizationNumber(info.utilization) ? info.utilization : null,
      resets_at: resetsAt,
    },
    can_defer: info.status === "rejected" && resetsAt !== null,
  };
}

// Parse newline-delimited Claude Code events. A terminal newline is allowed,
// but malformed JSON, blank records, non-object records, and records without a
// type are rejected rather than guessed around.
export function parseSessionStream(text) {
  if (typeof text !== "string") {
    throw new Error("Claude session stdout must be a string");
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  let init = null;
  let rateLimit = null;
  let result = null;
  let sessionId = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) {
      throw new Error(`Claude session stdout line ${index + 1} is blank`);
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Claude session stdout line ${index + 1} is not valid JSON`);
    }
    if (!isObject(event) || !nonEmptyString(event.type)) {
      throw new Error(`Claude session stdout line ${index + 1} is not a typed JSON object`);
    }
    if (nonEmptyString(event.session_id)) {
      if (sessionId !== null && event.session_id !== sessionId) {
        throw new Error("Claude session stdout contains conflicting session ids");
      }
      sessionId = event.session_id;
    }

    if (event.type === "system" && event.subtype === "init") {
      if (init !== null) {
        throw new Error("Claude session stdout contains multiple system init events");
      }
      init = {
        session_id: nonEmptyString(event.session_id) ? event.session_id : null,
        model: nonEmptyString(event.model) ? event.model : null,
      };
    }

    const parsedRateLimit = parseRateLimitEvent(event);
    if (parsedRateLimit !== null) {
      rateLimit = parsedRateLimit;
    }

    if (event.type === "result") {
      if (result !== null) {
        throw new Error("Claude session stdout contains multiple result events");
      }
      result = event;
    }
  }

  return { init, rate_limit: rateLimit, result };
}

// Alias the provider-specific name for callers that prefer it; both exports
// are pure and consume captured strings only.
export const parseClaudeStream = parseSessionStream;

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

function failureEnvelope(taskId, role, reason) {
  return {
    schema: "aios.result/v1",
    task: taskId,
    role,
    status: "failure",
    payload: { reason },
  };
}

function reportedSessionId(parsed) {
  if (nonEmptyString(parsed.result?.session_id)) {
    return parsed.result.session_id;
  }
  if (nonEmptyString(parsed.init?.session_id)) {
    return parsed.init.session_id;
  }
  if (nonEmptyString(parsed.rate_limit?.session_id)) {
    return parsed.rate_limit.session_id;
  }
  return null;
}

export function buildWorkerExecution({
  stdout,
  exitCode,
  taskId,
  role,
  startedAt,
  observedAt,
  expectedSessionId = null,
}) {
  const parsed = parseSessionStream(stdout);
  const model = parsed.init?.model ?? null;
  const finalUsage = sanitizeUsage(parsed.result?.usage);
  const finalCost = sanitizeCost(parsed.result?.total_cost_usd);
  const latestCapacity = parsed.rate_limit?.capacity ?? null;
  const sessionId = reportedSessionId(parsed);
  if (sessionId === null) {
    throw new Error("Claude session did not report a session_id");
  }

  const execution = (result, outcome, deferred = null) => ({
    schema: "aios.worker-execution/v1",
    result,
    deferred,
    session: {
      id: sessionId,
      task: taskId,
      role,
      model,
      started_at: startedAt,
      observed_at: observedAt,
      outcome,
      usage: finalUsage,
      cost_usd: finalCost,
      capacity: latestCapacity,
    },
  });
  const failed = (reason) =>
    execution(failureEnvelope(taskId, role, reason), "failed");

  if (expectedSessionId !== null && sessionId !== expectedSessionId) {
    return failed(
      `Claude resumed session ${sessionId} instead of expected session ${expectedSessionId}`,
    );
  }

  if (parsed.rate_limit?.can_defer === true) {
    return execution(
      null,
      "capacity_deferred",
      {
        kind: "capacity",
        retry_at: parsed.rate_limit.capacity.resets_at,
        continuation: sessionId,
      },
    );
  }

  if (exitCode !== 0) {
    return failed(`Claude session exited with code ${String(exitCode)}`);
  }
  const session = parsed.result;
  if (!isObject(session) || session.type !== "result" || typeof session.result !== "string") {
    return failed("Claude session returned an unexpected output structure");
  }
  if (session.is_error === true) {
    return failed(`Claude session reported an error: ${session.result.slice(0, 400)}`);
  }

  const payload = extractPayload(session.result);
  const problem = validatePayload(role, payload);
  if (problem !== null) {
    return failed(
      `unusable ${role} reply (${problem}): ${session.result.slice(0, 400)}`,
    );
  }

  const result = resultEnvelope(taskId, role, payload);
  return execution(result, result.status === "failure" ? "failed" : "completed");
}

export function sessionEnvironment(environment) {
  return {
    ...environment,
    CLAUDE_CODE_MAX_RETRIES: "0",
  };
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

export function runSession(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: sessionEnvironment(process.env),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let stdout = "";
    let inspectedThrough = 0;
    let deferredStdout = null;
    let termination = Promise.resolve();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (deferredStdout === null) {
        const newline = stdout.indexOf("\n", inspectedThrough);
        if (newline === -1) {
          break;
        }
        const line = stdout.slice(inspectedThrough, newline).replace(/\r$/, "");
        inspectedThrough = newline + 1;
        let event = null;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (parseRateLimitEvent(event)?.can_defer === true) {
          deferredStdout = stdout.slice(0, inspectedThrough);
          termination = terminateProcessTree(child);
        }
      }
    });
    child.once("error", (error) =>
      reject(new Error(`unable to start ${executable}: ${error.message}`)),
    );
    child.once("close", async (code) => {
      await termination;
      resolve({ stdout: deferredStdout ?? stdout, exitCode: code });
    });
  });
}

async function main() {
  const taskId = process.env.AIOS_TASK_ID;
  const role = process.env.AIOS_ROLE;
  if (!nonEmptyString(taskId) || !nonEmptyString(role)) {
    fail("AIOS_TASK_ID and AIOS_ROLE must be set by the Loop Engine");
  }

  const taskDocument = await readStdin();
  if (taskDocument.trim().length === 0) {
    fail("expected the Task document on stdin");
  }

  const prompt = rolePrompt(role, taskDocument);
  if (prompt === null) {
    fail(`unsupported Role: ${role}`);
  }

  const executable = process.env.AIOS_CLAUDE_CLI ?? process.argv[2] ?? "claude";
  const model = process.env.AIOS_CLAUDE_MODEL ?? "sonnet";
  const continuation = process.env.AIOS_WORKER_CONTINUATION;
  process.stderr.write(`claude-worker: starting ${role} session for ${taskId}\n`);

  const startedAt = new Date().toISOString();
  let sessionRun;
  try {
    sessionRun = await runSession(
      executable,
      sessionArguments(role, prompt, model, continuation),
    );
  } catch (error) {
    fail(error.message);
  }

  let execution;
  try {
    execution = buildWorkerExecution({
      stdout: sessionRun.stdout,
      exitCode: sessionRun.exitCode,
      taskId,
      role,
      startedAt,
      observedAt: new Date().toISOString(),
      expectedSessionId: nonEmptyString(continuation) ? continuation : null,
    });
  } catch (error) {
    fail(error.message);
  }

  process.stdout.write(JSON.stringify(execution));
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
      process.stderr.write(`claude-worker: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
