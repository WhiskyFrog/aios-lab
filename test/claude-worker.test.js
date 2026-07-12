import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildWorkerExecution,
  extractPayload,
  parseRateLimitEvent,
  parseSessionStream,
  runSession,
  sanitizeUsage,
  sessionArguments,
  sessionEnvironment,
  validatePayload,
} from "../workers/claude-worker.mjs";

const STARTED_AT = "2026-07-12T00:00:00.000Z";
const OBSERVED_AT = "2026-07-12T00:01:00.000Z";
const streamFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "claude-stream.js",
);

function ndjson(...events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

test("extractPayload accepts a reply that is exactly the JSON object", () => {
  const payload = extractPayload('{"summary":"done","verification":"ran tests"}');

  assert.deepEqual(payload, { summary: "done", verification: "ran tests" });
});

test("extractPayload accepts a reply wrapped in a markdown code fence", () => {
  const reply = ['```json', '{"decision":"approved"}', '```'].join("\n");

  assert.deepEqual(extractPayload(reply), { decision: "approved" });
});

test("extractPayload accepts a reply surrounded by prose", () => {
  const reply = 'Here is my answer:\n{"verdict":"pass","findings":"looks good"}\nThanks.';

  assert.deepEqual(extractPayload(reply), { verdict: "pass", findings: "looks good" });
});

test("extractPayload ignores stray prose braces that are not valid JSON", () => {
  const reply =
    'Note: {this is not json} the real reply is {"summary":"ok","verification":"checked"}';

  assert.deepEqual(extractPayload(reply), { summary: "ok", verification: "checked" });
});

test("extractPayload ignores braces nested inside a string value", () => {
  const reply = '{"summary":"uses a { character and a } too","verification":"checked"}';

  assert.deepEqual(extractPayload(reply), {
    summary: "uses a { character and a } too",
    verification: "checked",
  });
});

test("extractPayload returns null when no object can be found", () => {
  assert.equal(extractPayload("no JSON here at all"), null);
});

test("extractPayload returns null when multiple objects make extraction ambiguous", () => {
  const reply = 'First try: {"summary":"a","verification":"b"} second try: {"decision":"approved"}';

  assert.equal(extractPayload(reply), null);
});

test("extractPayload returns null for an unterminated object", () => {
  assert.equal(extractPayload('{"summary":"a","verification":"b"'), null);
});

test("validatePayload accepts a well-formed implementer reply", () => {
  assert.equal(
    validatePayload("implementer", { summary: "did work", verification: "ran suite" }),
    null,
  );
});

test("validatePayload rejects an implementer reply missing a key", () => {
  assert.match(
    validatePayload("implementer", { summary: "did work" }),
    /exactly summary and verification/,
  );
});

test("validatePayload accepts a well-formed reviewer reply", () => {
  assert.equal(
    validatePayload("reviewer", { verdict: "pass", findings: "all good" }),
    null,
  );
});

test("validatePayload rejects an invalid reviewer verdict", () => {
  assert.match(
    validatePayload("reviewer", { verdict: "maybe", findings: "all good" }),
    /verdict must be pass or changes_requested/,
  );
});

test("validatePayload accepts a well-formed approver reply", () => {
  assert.equal(validatePayload("approver", { decision: "approved" }), null);
});

test("validatePayload rejects an invalid approver decision", () => {
  assert.match(
    validatePayload("approver", { decision: "maybe" }),
    /decision must be approved or rejected/,
  );
});

test("validatePayload accepts a failure_reason reply for any role", () => {
  assert.equal(
    validatePayload("implementer", { failure_reason: "blocked on missing credentials" }),
    null,
  );
});

test("validatePayload rejects an empty failure_reason", () => {
  assert.match(
    validatePayload("reviewer", { failure_reason: "   " }),
    /failure_reason must be a non-empty string/,
  );
});

test("validatePayload rejects a non-object payload", () => {
  assert.match(validatePayload("implementer", null), /not a JSON object/);
});

test("sessionArguments requests verbose stream-json and preserves an exact continuation", () => {
  const args = sessionArguments("implementer", "the prompt", "sonnet", "session-123");

  assert.deepEqual(args.slice(0, 7), [
    "-p",
    "the prompt",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
  ]);
  assert.deepEqual(args.slice(7), [
    "--resume",
    "session-123",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash",
  ]);
});

test("sessionArguments keeps reviewer permissions and omits an empty continuation", () => {
  const args = sessionArguments("reviewer", "review", "opus", "   ");

  assert.equal(args.includes("--resume"), false);
  assert.deepEqual(args.slice(-2), ["--allowedTools", "Bash(npm test),Bash(npm test:*)"]);
});

test("sessionEnvironment disables Claude retries even when inherited settings differ", () => {
  assert.deepEqual(
    sessionEnvironment({ PATH: "somewhere", CLAUDE_CODE_MAX_RETRIES: "9" }),
    { PATH: "somewhere", CLAUDE_CODE_MAX_RETRIES: "0" },
  );
  assert.deepEqual(
    sessionEnvironment({ AIOS_CLAUDE_MAX_RETRIES: "4", CLAUDE_CODE_MAX_RETRIES: "9" }),
    { AIOS_CLAUDE_MAX_RETRIES: "4", CLAUDE_CODE_MAX_RETRIES: "0" },
  );
});

test("parseSessionStream captures init, the latest valid rate event, and final result", () => {
  const finalResult = {
    type: "result",
    session_id: "session-1",
    is_error: false,
    result: '{"summary":"done","verification":"tests pass"}',
  };
  const parsed = parseSessionStream(
    ndjson(
      { type: "system", subtype: "init", session_id: "session-1", model: "claude-sonnet" },
      {
        type: "rate_limit_event",
        session_id: "session-1",
        rate_limit_info: { status: "allowed", utilization: 0.2, resetsAt: 2_000_000_000 },
      },
      { type: "assistant", message: { content: [] } },
      {
        type: "rate_limit_event",
        session_id: "session-1",
        rate_limit_info: { status: "allowed_warning", utilization: 0.85 },
      },
      finalResult,
    ),
  );

  assert.deepEqual(parsed, {
    init: { session_id: "session-1", model: "claude-sonnet" },
    rate_limit: {
      session_id: "session-1",
      capacity: {
        status: "allowed_warning",
        utilization: 0.85,
        resets_at: null,
      },
      can_defer: false,
    },
    result: finalResult,
  });
});

test("parseSessionStream is strict about malformed and blank NDJSON records", () => {
  assert.throws(
    () => parseSessionStream('{"type":"system"}\nnot-json\n'),
    /line 2 is not valid JSON/,
  );
  assert.throws(
    () => parseSessionStream('{"type":"system"}\n\n{"type":"result"}\n'),
    /line 2 is blank/,
  );
  assert.throws(() => parseSessionStream("[]\n"), /not a typed JSON object/);
  assert.throws(
    () =>
      parseSessionStream(
        ndjson(
          { type: "system", subtype: "init", session_id: "session-a" },
          {
            type: "rate_limit_event",
            session_id: "session-b",
            rate_limit_info: { status: "rejected", resetsAt: 2_000_000_000 },
          },
        ),
      ),
    /conflicting session ids/,
  );
});

test("parseRateLimitEvent never derives reset data from non-numeric fields", () => {
  assert.deepEqual(
    parseRateLimitEvent({
      type: "rate_limit_event",
      session_id: "session-2",
      rate_limit_info: {
        status: "rejected",
        utilization: "100%",
        resetsAt: "in five hours",
      },
    }),
    {
      session_id: "session-2",
      capacity: { status: "rejected", utilization: null, resets_at: null },
      can_defer: false,
    },
  );
  assert.equal(
    parseRateLimitEvent({
      type: "rate_limit_event",
      session_id: "session-2",
      rate_limit_info: { status: "allowed", utilization: 1.1 },
    }).capacity.utilization,
    null,
  );
});

test("sanitizeUsage keeps only known non-negative numeric fields", () => {
  assert.equal(sanitizeUsage(null), null);
  assert.deepEqual(
    sanitizeUsage({
      input_tokens: 12,
      output_tokens: "7",
      cache_read_input_tokens: -1,
      unrelated_tokens: 999,
    }),
    {
      input_tokens: 12,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  );
});

test("buildWorkerExecution wraps a completed Result with sanitized session telemetry", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-3", model: "claude-sonnet" },
      {
        type: "rate_limit_event",
        session_id: "session-3",
        rate_limit_info: {
          status: "allowed_warning",
          utilization: 0.9,
          resetsAt: 2_000_000_000,
        },
      },
      {
        type: "result",
        session_id: "session-3",
        is_error: false,
        result: '{"summary":"implemented","verification":"suite passed"}',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 50,
          server_tool_use: { web_search_requests: 2 },
        },
        total_cost_usd: 0.42,
      },
    ),
    exitCode: 0,
    taskId: "task-0009",
    role: "implementer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(execution, {
    schema: "aios.worker-execution/v1",
    result: {
      schema: "aios.result/v1",
      task: "task-0009",
      role: "implementer",
      status: "success",
      payload: { summary: "implemented", verification: "suite passed" },
    },
    deferred: null,
    session: {
      id: "session-3",
      task: "task-0009",
      role: "implementer",
      model: "claude-sonnet",
      started_at: STARTED_AT,
      observed_at: OBSERVED_AT,
      outcome: "completed",
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 50,
      },
      cost_usd: 0.42,
      capacity: {
        status: "allowed_warning",
        utilization: 0.9,
        resets_at: "2033-05-18T03:33:20.000Z",
      },
    },
  });
});

test("buildWorkerExecution preserves a worker-declared failure Result", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-4", model: "claude-opus" },
      {
        type: "result",
        session_id: "session-4",
        is_error: false,
        result: '{"failure_reason":"credentials unavailable"}',
        total_cost_usd: -1,
      },
    ),
    exitCode: 0,
    taskId: "task-0009",
    role: "reviewer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(execution.result, {
    schema: "aios.result/v1",
    task: "task-0009",
    role: "reviewer",
    status: "failure",
    payload: { reason: "credentials unavailable" },
  });
  assert.equal(execution.session.usage, null);
  assert.equal(execution.session.cost_usd, null);
  assert.equal(execution.session.outcome, "failed");
});

test("buildWorkerExecution emits an exact capacity deferral despite a nonzero child exit", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-5", model: "claude-sonnet" },
      {
        type: "rate_limit_event",
        session_id: "session-5",
        rate_limit_info: { status: "rejected", utilization: 1, resetsAt: 2_000_000_000 },
      },
    ),
    exitCode: 17,
    taskId: "task-0009",
    role: "implementer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(execution, {
    schema: "aios.worker-execution/v1",
    result: null,
    deferred: {
      kind: "capacity",
      retry_at: "2033-05-18T03:33:20.000Z",
      continuation: "session-5",
    },
    session: {
      id: "session-5",
      task: "task-0009",
      role: "implementer",
      model: "claude-sonnet",
      started_at: STARTED_AT,
      observed_at: OBSERVED_AT,
      outcome: "capacity_deferred",
      usage: null,
      cost_usd: null,
      capacity: {
        status: "rejected",
        utilization: 1,
        resets_at: "2033-05-18T03:33:20.000Z",
      },
    },
  });
});

test("invalid rejected fields become an ordinary failure with session telemetry", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson({
      type: "rate_limit_event",
      session_id: "session-6",
      rate_limit_info: { status: "rejected", resetsAt: "tomorrow" },
    }),
    exitCode: 9,
    taskId: "task-0009",
    role: "implementer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.equal(execution.deferred, null);
  assert.equal(execution.result.status, "failure");
  assert.match(execution.result.payload.reason, /exited with code 9/);
  assert.equal(execution.session.outcome, "failed");
  assert.equal(execution.session.capacity.status, "rejected");
});

test("structured Claude errors retain usage and cost in a failed execution", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-error", model: "sonnet" },
      {
        type: "result",
        session_id: "session-error",
        is_error: true,
        result: "authentication failed",
        usage: { input_tokens: 10, output_tokens: 2 },
        total_cost_usd: 0.003,
      },
    ),
    exitCode: 0,
    taskId: "task-0009",
    role: "reviewer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.equal(execution.result.status, "failure");
  assert.match(execution.result.payload.reason, /authentication failed/);
  assert.equal(execution.session.outcome, "failed");
  assert.equal(execution.session.usage.input_tokens, 10);
  assert.equal(execution.session.cost_usd, 0.003);
});

test("a resumed Claude execution must report the expected session id", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-b", model: "sonnet" },
      {
        type: "result",
        session_id: "session-b",
        is_error: false,
        result: '{"summary":"done","verification":"checked"}',
      },
    ),
    exitCode: 0,
    taskId: "task-0009",
    role: "implementer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
    expectedSessionId: "session-a",
  });

  assert.equal(execution.result.status, "failure");
  assert.match(execution.result.payload.reason, /instead of expected session session-a/);
  assert.equal(execution.session.id, "session-b");
  assert.equal(execution.session.outcome, "failed");
});

test("rejected prose in a successful final reply never creates a deferral", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "system", subtype: "init", session_id: "session-7", model: "claude-sonnet" },
      {
        type: "result",
        session_id: "session-7",
        is_error: false,
        result:
          '{"summary":"saw status rejected and resetsAt 2000000000 in a file","verification":"checked"}',
      },
    ),
    exitCode: 0,
    taskId: "task-0009",
    role: "implementer",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });

  assert.equal(execution.deferred, null);
  assert.equal(execution.session.outcome, "completed");
  assert.equal(execution.session.capacity, null);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "runSession terminates the Claude process tree after structured capacity rejection",
  { timeout: 5_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aios-claude-tree-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pidPath = path.join(directory, "descendant.pid");

    const run = await runSession(process.execPath, [
      streamFixture,
      "defer-tree",
      pidPath,
    ]);
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    t.after(() => {
      if (processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    });

    assert.equal(parseSessionStream(run.stdout).rate_limit.can_defer, true);
    assert.equal(processExists(descendantPid), false);
  },
);
