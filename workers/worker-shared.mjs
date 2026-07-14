// Shared logic for AIOS command Worker adapters (see .aios/results/README.md
// for the Result v1 contract). Role prompts, reply extraction, payload
// validation, and failure discipline are identical across vendors; only
// session launch and transport differ per adapter.

import process from "node:process";

const VERDICTS = new Set(["pass", "changes_requested"]);
const DECISIONS = new Set(["approved", "rejected"]);
const FAILURE_KINDS = new Set(["verification_failed", "context_insufficient"]);

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
    'If you cannot complete the work, reply instead with: {"failure_reason":"<why>"}.',
    'For an objectively detected verification or context failure, you may add exactly "failure_kind":"verification_failed" or "failure_kind":"context_insufficient".',
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

// A failure is reported by throwing WorkerFailure. This makes "the adapter
// cannot continue past a failure" a language-enforced fact rather than a
// convention call sites have to honor correctly: throwing unwinds the
// current call stack immediately, so nothing after a fail() call can run,
// and only the adapter's top-level catch turns a failure into the stderr
// diagnostic and nonzero exit.
export class WorkerFailure extends Error {}

export function fail(message) {
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
  if (
    keys.join(",") === "failure_reason" ||
    keys.join(",") === "failure_kind,failure_reason"
  ) {
    if (!nonEmptyString(payload.failure_reason)) {
      return "failure_reason must be a non-empty string";
    }
    return !Object.hasOwn(payload, "failure_kind") || FAILURE_KINDS.has(payload.failure_kind)
      ? null
      : "failure_kind must be verification_failed or context_insufficient";
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

export async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}
