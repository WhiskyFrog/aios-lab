import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  capacityFromAppServer,
  queryCodexCapacity,
} from "../workers/codex-capacity.mjs";
import {
  buildResult,
  buildWorkerExecution,
  execArguments,
  launchCommand,
  parseCodexStream,
  runCodex,
  sanitizeCodexUsage,
  sandboxForRole,
  sessionArguments,
} from "../workers/codex-worker.mjs";

const STARTED_AT = "2026-07-14T00:00:00.000Z";
const OBSERVED_AT = "2026-07-14T00:01:00.000Z";
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexFixture = path.join(repoRoot, "fixtures", "codex-cli.js");
const usageLimitFixture = path.join(repoRoot, "fixtures", "codex-usage-limit.ndjson");
const codexWorker = path.join(repoRoot, "workers", "codex-worker.mjs");
const FUTURE_RESET_SECONDS = 4_000_000_000;

function ndjson(...events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

test("sandboxForRole maps workspace-write to the Implementer and read-only elsewhere", () => {
  assert.equal(sandboxForRole("implementer"), "workspace-write");
  assert.equal(sandboxForRole("reviewer"), "read-only");
  assert.equal(sandboxForRole("approver"), "read-only");
  assert.equal(sandboxForRole("unknown"), null);
});

test("launchCommand prefers trailing argv tokens over AIOS_CODEX_CLI and the bare default", () => {
  assert.deepEqual(
    launchCommand(["node", "C:\\codex\\cli.js"], { AIOS_CODEX_CLI: "C:\\codex\\codex.exe" }),
    ["node", "C:\\codex\\cli.js"],
  );
  assert.deepEqual(launchCommand([], { AIOS_CODEX_CLI: "C:\\codex\\codex.exe" }), [
    "C:\\codex\\codex.exe",
  ]);
  assert.deepEqual(launchCommand([], {}), ["codex"]);
});

test("sessionArguments enables JSONL, applies the Role sandbox, and sets a model", () => {
  const args = execArguments("implementer", "the prompt", "C:\\tmp\\out.txt", "gpt-5.5");
  assert.deepEqual(args, [
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    "C:\\tmp\\out.txt",
    "--model",
    "gpt-5.5",
    "the prompt",
  ]);
  assert.equal(args.some((token) => token.startsWith("--dangerously")), false);
});

test("sessionArguments resumes the exact thread and keeps read-only permissions", () => {
  const args = sessionArguments(
    "reviewer",
    "review this",
    "C:\\tmp\\out.txt",
    undefined,
    "thread-123",
  );
  assert.deepEqual(args.slice(-3), ["resume", "thread-123", "review this"]);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args.includes("--json"), true);
  assert.equal(args.includes("--model"), false);
});

test("sessionArguments never emits a dangerous bypass flag for any Role", () => {
  for (const role of ["implementer", "reviewer", "approver"]) {
    const args = sessionArguments(role, "prompt", "out", "model", "thread-1");
    assert.equal(args.some((token) => String(token).startsWith("--dangerously")), false);
  }
});

test("sanitizeCodexUsage normalizes cached input into disjoint ledger fields", () => {
  assert.equal(sanitizeCodexUsage(null), null);
  assert.deepEqual(
    sanitizeCodexUsage({
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    }),
    {
      input_tokens: 60,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40,
    },
  );
});

test("parseCodexStream reads the public thread, completion, and usage events", () => {
  const completed = { type: "turn.completed", usage: { input_tokens: 10 } };
  assert.deepEqual(
    parseCodexStream(
      ndjson(
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item-1", type: "agent_message" } },
        completed,
      ),
    ),
    { thread_id: "thread-1", completed, failed: null, stream_error: null },
  );
});

test("parseCodexStream strictly rejects malformed or conflicting streams", () => {
  assert.throws(() => parseCodexStream("not-json\n"), /line 1 is not valid JSON/);
  assert.throws(
    () => parseCodexStream(ndjson({ type: "turn.started" })),
    /did not report a thread_id/,
  );
  assert.throws(
    () =>
      parseCodexStream(
        ndjson(
          { type: "thread.started", thread_id: "thread-1" },
          { type: "turn.completed", usage: {} },
          { type: "turn.failed", error: { message: "failed" } },
        ),
      ),
    /both completed and failed turns/,
  );
});

test("captured real Codex usage-limit JSONL has no machine-readable reset", async () => {
  const parsed = parseCodexStream(await readFile(usageLimitFixture, "utf8"));
  assert.equal(parsed.thread_id, "019a77e4-0716-7152-8396-b642e26c3e20");
  assert.match(parsed.failed.error.message, /usage limit/);
  assert.deepEqual(Object.keys(parsed.failed.error), ["message"]);
  assert.equal(parsed.completed, null);
});

function appServerEvidence({
  threadId = "thread-capacity",
  errorInfo = "usageLimitExceeded",
  reachedType = "rate_limit_reached",
  primary = { usedPercent: 100, resetsAt: FUTURE_RESET_SECONDS },
  secondary = null,
} = {}) {
  return {
    threadId,
    thread: {
      id: 2,
      result: {
        thread: { id: threadId },
        initialTurnsPage: {
          data: [
            {
              id: "turn-latest",
              status: "failed",
              error: {
                message: "arbitrary human prose",
                codexErrorInfo: errorInfo,
              },
            },
          ],
        },
      },
    },
    rates: {
      id: 3,
      result: {
        rateLimits: {
          limitId: "codex",
          primary,
          secondary,
          rateLimitReachedType: reachedType,
        },
      },
    },
  };
}

test("capacityFromAppServer requires exact structured usage-limit and reset evidence", () => {
  const evidence = appServerEvidence();
  assert.deepEqual(
    capacityFromAppServer(
      evidence.threadId,
      evidence.thread,
      evidence.rates,
      Date.parse("2026-07-14T00:00:00Z"),
    ),
    {
      retry_at: "2096-10-02T07:06:40.000Z",
      capacity: {
        status: "rejected",
        utilization: 1,
        resets_at: "2096-10-02T07:06:40.000Z",
      },
    },
  );

  for (const changed of [
    appServerEvidence({ errorInfo: "internalServerError" }),
    appServerEvidence({ reachedType: null }),
    appServerEvidence({ primary: { usedPercent: 99, resetsAt: FUTURE_RESET_SECONDS } }),
    appServerEvidence({ primary: { usedPercent: 100, resetsAt: null } }),
    appServerEvidence({ primary: { usedPercent: 100, resetsAt: 1 } }),
  ]) {
    assert.equal(
      capacityFromAppServer(
        changed.threadId,
        changed.thread,
        changed.rates,
        Date.parse("2026-07-14T00:00:00Z"),
      ),
      null,
    );
  }
});

test("capacityFromAppServer waits for every exhausted rate window", () => {
  const evidence = appServerEvidence({
    primary: { usedPercent: 100, resetsAt: 3_000_000_000 },
    secondary: { usedPercent: 100, resetsAt: FUTURE_RESET_SECONDS },
  });
  const capacity = capacityFromAppServer(
    evidence.threadId,
    evidence.thread,
    evidence.rates,
    Date.parse("2026-07-14T00:00:00Z"),
  );
  assert.equal(capacity.retry_at, "2096-10-02T07:06:40.000Z");
});

test("queryCodexCapacity performs the app-server handshake with the same launcher", async () => {
  const capacity = await queryCodexCapacity({
    command: [process.execPath, codexFixture],
    threadId: "thread-app-server",
    environment: {
      ...process.env,
      CODEX_FIXTURE_MODE: "usage-limit",
      CODEX_FIXTURE_RESETS_AT: String(FUTURE_RESET_SECONDS),
    },
    cwd: repoRoot,
    nowMilliseconds: Date.parse("2026-07-14T00:00:00Z"),
  });
  assert.equal(capacity.retry_at, "2096-10-02T07:06:40.000Z");
});

test("buildWorkerExecution wraps a completed Result with Codex session telemetry", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "thread.started", thread_id: "thread-2" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
      },
    ),
    exitCode: 0,
    reply: '{"summary":"implemented","verification":"suite passed"}',
    taskId: "task-0011",
    role: "implementer",
    model: "gpt-5.5",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });
  assert.equal(execution.schema, "aios.worker-execution/v1");
  assert.equal(execution.deferred, null);
  assert.equal(execution.result.status, "success");
  assert.deepEqual(execution.session, {
    id: "thread-2",
    task: "task-0011",
    role: "implementer",
    model: "gpt-5.5",
    started_at: STARTED_AT,
    observed_at: OBSERVED_AT,
    outcome: "completed",
    usage: {
      input_tokens: 60,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40,
    },
    cost_usd: null,
    capacity: null,
  });
});

test("usage-limit prose remains an ordinary failure and never a capacity deferral", async () => {
  const execution = buildWorkerExecution({
    stdout: await readFile(usageLimitFixture, "utf8"),
    exitCode: 1,
    reply: null,
    taskId: "task-0011",
    role: "implementer",
    model: "gpt-5",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
  });
  assert.equal(execution.deferred, null);
  assert.equal(execution.session.outcome, "failed");
  assert.equal(execution.session.capacity, null);
  assert.equal(execution.result.status, "failure");
  assert.match(execution.result.payload.reason, /usage limit/);
});

test("structured app-server evidence turns a failed Codex thread into a deferral", async () => {
  const execution = buildWorkerExecution({
    stdout: await readFile(usageLimitFixture, "utf8"),
    exitCode: 1,
    reply: null,
    taskId: "task-0011",
    role: "implementer",
    model: "gpt-5",
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
    capacityEvidence: {
      retry_at: "2096-10-02T07:06:40.000Z",
      capacity: {
        status: "rejected",
        utilization: 1,
        resets_at: "2096-10-02T07:06:40.000Z",
      },
    },
  });
  assert.equal(execution.result, null);
  assert.deepEqual(execution.deferred, {
    kind: "capacity",
    retry_at: "2096-10-02T07:06:40.000Z",
    continuation: "019a77e4-0716-7152-8396-b642e26c3e20",
  });
  assert.equal(execution.session.outcome, "capacity_deferred");
});

test("a resumed Codex execution must report the expected thread id", () => {
  const execution = buildWorkerExecution({
    stdout: ndjson(
      { type: "thread.started", thread_id: "wrong-thread" },
      { type: "turn.completed", usage: {} },
    ),
    exitCode: 0,
    reply: '{"verdict":"pass","findings":"ok"}',
    taskId: "task-0011",
    role: "reviewer",
    model: null,
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
    expectedSessionId: "expected-thread",
  });
  assert.equal(execution.session.outcome, "failed");
  assert.match(execution.result.payload.reason, /instead of expected session/);
});

test("buildResult retains legacy pure Result handling", () => {
  assert.equal(
    buildResult("task-0011", "reviewer", 0, '{"verdict":"pass","findings":"ok"}').status,
    "success",
  );
  assert.throws(
    () => buildResult("task-0011", "implementer", 1, '{"summary":"a","verification":"b"}'),
    /exited with code 1/,
  );
});

test("runCodex captures JSONL stdout and the child exit code", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-codex-run-"));
  const outputFile = path.join(directory, "last-message.txt");
  const previousMode = process.env.CODEX_FIXTURE_MODE;
  const previousRole = process.env.AIOS_ROLE;
  process.env.CODEX_FIXTURE_MODE = "success";
  process.env.AIOS_ROLE = "reviewer";
  try {
    const run = await runCodex(
      [process.execPath, codexFixture],
      sessionArguments("reviewer", "review", outputFile, undefined),
    );
    assert.equal(run.exitCode, 0);
    assert.equal(parseCodexStream(run.stdout).completed.type, "turn.completed");
    assert.match(await readFile(outputFile, "utf8"), /"verdict":"pass"/);
  } finally {
    process.env.CODEX_FIXTURE_MODE = previousMode;
    process.env.AIOS_ROLE = previousRole;
    await rm(directory, { recursive: true, force: true });
  }
});

function runAdapter({
  mode,
  role,
  taskDocument,
  continuation = null,
  appServerMode = "normal",
}) {
  const env = {
    ...process.env,
    AIOS_TASK_ID: "task-0011",
    AIOS_ROLE: role,
    AIOS_CODEX_MODEL: "gpt-fixture",
    CODEX_FIXTURE_MODE: mode,
    CODEX_FIXTURE_APP_SERVER_MODE: appServerMode,
    CODEX_FIXTURE_RESETS_AT: String(FUTURE_RESET_SECONDS),
  };
  delete env.AIOS_WORKER_CONTINUATION;
  if (continuation !== null) {
    env.AIOS_WORKER_CONTINUATION = continuation;
  }
  return spawnSync(process.execPath, [codexWorker, process.execPath, codexFixture], {
    cwd: repoRoot,
    input: taskDocument,
    encoding: "utf8",
    env,
  });
}

const TASK_DOCUMENT = "---\nschema: aios.task/v1\n---\n\n## Objective\n\nExercise Codex.\n";

test("codex-worker end to end emits one completed worker execution", () => {
  const run = runAdapter({ mode: "success", role: "implementer", taskDocument: TASK_DOCUMENT });
  assert.equal(run.status, 0);
  const execution = JSON.parse(run.stdout);
  assert.equal(execution.schema, "aios.worker-execution/v1");
  assert.equal(execution.result.status, "success");
  assert.equal(execution.session.outcome, "completed");
  assert.equal(execution.session.model, "gpt-fixture");
});

test("codex-worker end to end records worker-declared and CLI failures", () => {
  const declared = runAdapter({
    mode: "failure-reason",
    role: "reviewer",
    taskDocument: TASK_DOCUMENT,
  });
  assert.equal(declared.status, 0);
  assert.equal(JSON.parse(declared.stdout).result.payload.reason, "codex could not proceed");

  const cliFailure = runAdapter({
    mode: "nonzero",
    role: "implementer",
    taskDocument: TASK_DOCUMENT,
  });
  assert.equal(cliFailure.status, 0);
  const execution = JSON.parse(cliFailure.stdout);
  assert.equal(execution.session.outcome, "failed");
  assert.match(execution.result.payload.reason, /synthetic Codex failure/);
});

test("codex-worker end to end defers a structured usage limit", () => {
  const run = runAdapter({
    mode: "usage-limit",
    role: "implementer",
    taskDocument: TASK_DOCUMENT,
  });
  assert.equal(run.status, 0, run.stderr);
  const execution = JSON.parse(run.stdout);
  assert.equal(execution.result, null);
  assert.equal(execution.session.outcome, "capacity_deferred");
  assert.equal(execution.deferred.retry_at, "2096-10-02T07:06:40.000Z");
  assert.equal(execution.deferred.continuation, execution.session.id);
});

test("a Codex deferral continuation resumes and completes the exact thread", () => {
  const deferredRun = runAdapter({
    mode: "usage-limit",
    role: "reviewer",
    taskDocument: TASK_DOCUMENT,
  });
  assert.equal(deferredRun.status, 0, deferredRun.stderr);
  const deferred = JSON.parse(deferredRun.stdout);

  const resumedRun = runAdapter({
    mode: "success",
    role: "reviewer",
    taskDocument: TASK_DOCUMENT,
    continuation: deferred.deferred.continuation,
  });
  assert.equal(resumedRun.status, 0, resumedRun.stderr);
  const resumed = JSON.parse(resumedRun.stdout);
  assert.equal(resumed.session.id, deferred.session.id);
  assert.equal(resumed.session.outcome, "completed");
  assert.equal(resumed.result.status, "success");
});

test("codex-worker fails closed when the structured capacity probe is unavailable", () => {
  const run = runAdapter({
    mode: "usage-limit",
    role: "implementer",
    taskDocument: TASK_DOCUMENT,
    appServerMode: "unavailable",
  });
  assert.equal(run.status, 0, run.stderr);
  const execution = JSON.parse(run.stdout);
  assert.equal(execution.deferred, null);
  assert.equal(execution.session.outcome, "failed");
  assert.match(run.stderr, /structured capacity probe unavailable/);
});

test("codex-worker end to end resumes exactly the supplied continuation", () => {
  const run = runAdapter({
    mode: "success",
    role: "reviewer",
    taskDocument: TASK_DOCUMENT,
    continuation: "thread-resume-1",
  });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).session.id, "thread-resume-1");
});

test("codex-worker records a completed turn with no final message as failed", () => {
  const run = runAdapter({ mode: "no-output", role: "approver", taskDocument: TASK_DOCUMENT });
  assert.equal(run.status, 0);
  const execution = JSON.parse(run.stdout);
  assert.equal(execution.session.outcome, "failed");
  assert.match(execution.result.payload.reason, /no final message/);
});
