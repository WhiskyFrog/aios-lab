import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionLedger } from "../src/sessions.js";
import {
  CapacityDeferredError,
  CommandWorker,
  WorkerError,
  workerEnvironment,
} from "../src/workers.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "command-worker.js",
);

const task = {
  metadata: { id: "task-0042", state: "implement" },
  raw: "---\nschema: aios.task/v1\n---\n\n## Objective\n\nExercise stdin.\n",
};

test("CommandWorker sends the full Task on stdin and parses one JSON Result", async () => {
  const worker = new CommandWorker([process.execPath, fixture, "success"]);

  const result = await worker.execute(task);

  assert.deepEqual(result, {
    schema: "aios.result/v1",
    task: "task-0042",
    role: "implementer",
    status: "success",
    payload: {
      summary: "Received the complete Task document.",
      verification: "Command fixture completed.",
    },
  });
});

test("fresh Worker invocations clear an inherited continuation", () => {
  const inherited = {
    PATH: "fixture-path",
    AIOS_WORKER_CONTINUATION: "stale-session",
  };
  const fresh = workerEnvironment(inherited, "task-0042", "implementer");
  const resumed = workerEnvironment(
    inherited,
    "task-0042",
    "reviewer",
    "exact-session",
  );

  assert.equal(fresh.AIOS_WORKER_CONTINUATION, undefined);
  assert.equal(resumed.AIOS_WORKER_CONTINUATION, "exact-session");
  assert.equal(inherited.AIOS_WORKER_CONTINUATION, "stale-session");
});

test("CommandWorker rejects a non-zero process exit", async () => {
  const worker = new CommandWorker([process.execPath, fixture, "nonzero"]);

  await assert.rejects(
    worker.execute(task),
    (error) =>
      error instanceof WorkerError &&
      /code 7/.test(error.message) &&
      /fixture failure/.test(error.message),
  );
});

test("CommandWorker rejects malformed or additional stdout", async () => {
  const worker = new CommandWorker([process.execPath, fixture, "malformed"]);

  await assert.rejects(
    worker.execute(task),
    (error) =>
      error instanceof WorkerError &&
      /exactly one JSON Result/.test(error.message),
  );
});

test("CommandWorker unwraps a structured execution and records its session", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-worker-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "capacity");
  await writeFile(`${marker}.implementer`, "deferred", "utf8");
  const ledger = new SessionLedger(path.join(directory, "sessions.json"));
  const worker = new CommandWorker(
    [process.execPath, fixture, "capacity-loop", marker],
    { ledger },
  );

  const result = await worker.execute(task, {
    continuation: "fixture-implementer",
  });

  assert.equal(result.status, "success");
  assert.equal(result.role, "implementer");
  const recorded = await ledger.load();
  assert.equal(recorded.sessions.length, 1);
  assert.equal(recorded.sessions[0].id, "fixture-implementer");
  assert.equal(recorded.sessions[0].usage.input_tokens, 100);
});

test("CommandWorker exposes only a structured capacity deferral as typed control", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-worker-deferred-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new SessionLedger(path.join(directory, "sessions.json"));
  const worker = new CommandWorker([process.execPath, fixture, "deferred"], {
    ledger,
  });

  await assert.rejects(
    worker.execute(task),
    (error) =>
      error instanceof CapacityDeferredError &&
      error.continuation === "fixture-implementer" &&
      error.sessionId === "fixture-implementer" &&
      Date.parse(error.retryAt) > Date.now(),
  );
  const recorded = await ledger.load();
  assert.equal(recorded.sessions[0].outcome, "capacity_deferred");
  assert.equal(recorded.sessions[0].capacity.status, "rejected");
});

test("CommandWorker rejects telemetry for a different Task or Role", async () => {
  const worker = new CommandWorker([
    process.execPath,
    fixture,
    "execution-mismatch",
  ]);

  await assert.rejects(
    worker.execute(task),
    /session does not match the active Task and Role/,
  );
});

test("CommandWorker records a structured failed execution before returning its Result", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-worker-failed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new SessionLedger(path.join(directory, "sessions.json"));
  const worker = new CommandWorker(
    [process.execPath, fixture, "execution-failure"],
    { ledger },
  );

  const result = await worker.execute(task);
  assert.equal(result.status, "failure");
  assert.equal(result.payload.reason, "structured fixture failure");
  const recorded = await ledger.load();
  assert.equal(recorded.sessions[0].outcome, "failed");
  assert.equal(recorded.sessions[0].usage.input_tokens, 100);
});

test("CommandWorker force-terminates a timed-out process", async () => {
  const worker = new CommandWorker(
    [process.execPath, fixture, "hang"],
    { timeoutMs: 50 },
  );

  await assert.rejects(
    worker.execute(task),
    (error) =>
      error instanceof WorkerError &&
      /timed out/.test(error.message),
  );
});

test("CommandWorker force-terminates an active process when the run is cancelled", async () => {
  const controller = new AbortController();
  const worker = new CommandWorker([process.execPath, fixture, "hang"], {
    timeoutMs: 10_000,
  });
  const execution = worker.execute(task, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(execution, /execution was cancelled/);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("CommandWorker waits for a timed-out descendant tree to terminate", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-worker-tree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = path.join(directory, "descendant.pid");
  const worker = new CommandWorker(
    [process.execPath, fixture, "hang-tree", pidPath],
    { timeoutMs: 150 },
  );

  await assert.rejects(worker.execute(task), /timed out/);
  const descendantPid = Number(await readFile(pidPath, "utf8"));
  t.after(() => {
    if (processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
  });
  assert.equal(processExists(descendantPid), false);
});
