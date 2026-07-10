#!/usr/bin/env node
// Claude Code worker adapter for the AIOS Loop Engine.
//
// Contract (see .aios/results/README.md): the engine pipes the Task document
// to stdin, sets AIOS_TASK_ID and AIOS_ROLE, and expects exactly one
// aios.result/v1 JSON object on stdout. This adapter runs one non-interactive
// Claude Code session for the Role and translates its reply into that
// envelope. Any unusable session output exits nonzero so the engine halts
// without a Task transition.
//
// Usage in an Assignment: ["node", "workers/claude-worker.mjs", "<claude-cli>"]
// The optional argument (or AIOS_CLAUDE_CLI) names the Claude executable;
// AIOS_CLAUDE_MODEL overrides the model alias (default "sonnet").

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERDICTS = new Set(["pass", "changes_requested"]);
const DECISIONS = new Set(["approved", "rejected"]);

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

export function sessionArguments(role, prompt, model) {
  const base = ["-p", prompt, "--output-format", "json", "--model", model];
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

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

function runSession(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Claude session exited with code ${String(code)}`));
        return;
      }
      resolve(stdout);
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
  process.stderr.write(`claude-worker: starting ${role} session for ${taskId}\n`);

  let sessionStdout;
  try {
    sessionStdout = await runSession(executable, sessionArguments(role, prompt, model));
  } catch (error) {
    fail(error.message);
  }

  let session;
  try {
    session = JSON.parse(sessionStdout);
  } catch {
    fail("Claude session stdout was not the expected JSON envelope");
  }
  if (!isObject(session) || session.type !== "result" || typeof session.result !== "string") {
    fail("Claude session returned an unexpected output structure");
  }
  if (session.is_error === true) {
    fail(`Claude session reported an error: ${session.result.slice(0, 400)}`);
  }

  const payload = extractPayload(session.result);
  const problem = validatePayload(role, payload);
  if (problem !== null) {
    fail(`unusable ${role} reply (${problem}): ${session.result.slice(0, 400)}`);
  }

  const envelope =
    Object.keys(payload).length === 1 && "failure_reason" in payload
      ? {
          schema: "aios.result/v1",
          task: taskId,
          role,
          status: "failure",
          payload: { reason: payload.failure_reason },
        }
      : { schema: "aios.result/v1", task: taskId, role, status: "success", payload };

  process.stdout.write(JSON.stringify(envelope));
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
