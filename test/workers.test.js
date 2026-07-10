import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CommandWorker, WorkerError } from "../src/workers.js";

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
