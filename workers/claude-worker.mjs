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
import process from "node:process";

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

function rolePrompt(role, taskDocument) {
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

function sessionArguments(role, prompt) {
  const model = process.env.AIOS_CLAUDE_MODEL ?? "sonnet";
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

function fail(message) {
  process.stderr.write(`claude-worker: ${message}\n`);
  process.exit(1);
}

function extractPayload(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validatePayload(role, payload) {
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
process.stderr.write(`claude-worker: starting ${role} session for ${taskId}\n`);

let sessionStdout;
try {
  sessionStdout = await runSession(executable, sessionArguments(role, prompt));
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
