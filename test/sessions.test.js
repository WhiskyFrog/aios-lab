import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SessionLedger,
  WORKER_EXECUTION_SCHEMA,
  validateWorkerExecution,
} from "../src/sessions.js";

function completedSession(overrides = {}) {
  return {
    id: "claude-implementer-a",
    task: "task-0009",
    role: "implementer",
    model: "claude-sonnet",
    started_at: "2026-07-12T01:00:00.000Z",
    observed_at: "2026-07-12T01:01:00.000Z",
    outcome: "completed",
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
    },
    cost_usd: 0.04,
    capacity: {
      status: "allowed_warning",
      utilization: 0.825,
      resets_at: "2026-07-12T05:00:00.000Z",
    },
    ...overrides,
  };
}

async function temporaryLedger(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "runtime", "sessions.json");
}

test("SessionLedger returns a valid empty ledger for a missing file", async (t) => {
  const ledger = new SessionLedger(await temporaryLedger(t));

  assert.deepEqual(await ledger.load(), {
    schema: "aios.sessions/v1",
    updated_at: null,
    sessions: [],
  });
});

test("SessionLedger records sessions atomically in deterministic order", async (t) => {
  const filePath = await temporaryLedger(t);
  const ledger = new SessionLedger(filePath);
  await ledger.record(
    completedSession({
      id: "later",
      started_at: "2026-07-12T02:00:00Z",
      observed_at: "2026-07-12T02:01:00Z",
    }),
  );
  const recorded = await ledger.record(completedSession({ id: "earlier" }));

  assert.deepEqual(recorded.sessions.map(({ id }) => id), ["earlier", "later"]);
  assert.equal(recorded.updated_at, "2026-07-12T02:01:00.000Z");
  assert.equal(recorded.sessions[0].invocations, 1);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), recorded);
});

test("SessionLedger merges repeated ids and keeps chronological bounds", async (t) => {
  const ledger = new SessionLedger(await temporaryLedger(t));
  await ledger.record(completedSession());
  const merged = await ledger.record(
    completedSession({
      started_at: "2026-07-12T00:59:00Z",
      observed_at: "2026-07-12T01:04:00Z",
      outcome: "capacity_deferred",
      usage: null,
      cost_usd: null,
      capacity: {
        status: "rejected",
        utilization: 1,
        resets_at: "2026-07-12T05:00:00Z",
      },
    }),
  );

  assert.deepEqual(merged.sessions[0], {
    id: "claude-implementer-a",
    task: "task-0009",
    role: "implementer",
    model: "claude-sonnet",
    first_seen_at: "2026-07-12T00:59:00.000Z",
    last_seen_at: "2026-07-12T01:04:00.000Z",
    invocations: 2,
    outcome: "capacity_deferred",
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
    },
    cost_usd: 0.04,
    capacity: {
      status: "rejected",
      utilization: 1,
      resets_at: "2026-07-12T05:00:00.000Z",
    },
  });
});

test("SessionLedger totals usage and cost across resumed invocations", async (t) => {
  const ledger = new SessionLedger(await temporaryLedger(t));
  await ledger.record(completedSession());
  const merged = await ledger.record(
    completedSession({
      started_at: "2026-07-12T01:02:00Z",
      observed_at: "2026-07-12T01:03:00Z",
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 25,
      },
      cost_usd: 0.01,
      capacity: null,
    }),
  );

  assert.deepEqual(merged.sessions[0].usage, {
    input_tokens: 200,
    output_tokens: 50,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 35,
  });
  assert.equal(merged.sessions[0].cost_usd, 0.05);
  assert.equal(merged.sessions[0].capacity.status, "allowed_warning");
  assert.equal(merged.sessions[0].invocations, 2);
});

test("SessionLedger rejects invalid persisted ledgers and id reassignment", async (t) => {
  const filePath = await temporaryLedger(t);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ schema: "aios.sessions/v1", updated_at: null, sessions: [], extra: true }),
  );
  await assert.rejects(new SessionLedger(filePath).load(), /contain exactly/);

  const otherPath = path.join(path.dirname(filePath), "other.json");
  const ledger = new SessionLedger(otherPath);
  await ledger.record(completedSession());
  await assert.rejects(
    ledger.record(completedSession({ task: "task-0010" })),
    /cannot change task or role/,
  );
});

test("validateWorkerExecution normalizes completed and deferred envelopes", () => {
  const completed = validateWorkerExecution({
    schema: WORKER_EXECUTION_SCHEMA,
    result: { schema: "aios.result/v1", status: "success" },
    deferred: null,
    session: completedSession(),
  });
  assert.equal(completed.session.started_at, "2026-07-12T01:00:00.000Z");
  assert.deepEqual(completed.result, {
    schema: "aios.result/v1",
    status: "success",
  });

  const deferred = validateWorkerExecution({
    schema: WORKER_EXECUTION_SCHEMA,
    result: null,
    deferred: {
      kind: "capacity",
      retry_at: "2026-07-12T05:00:00+00:00",
      continuation: " session-123 ",
    },
    session: completedSession({
      outcome: "capacity_deferred",
      usage: null,
      cost_usd: null,
      capacity: {
        status: "rejected",
        utilization: null,
        resets_at: "2026-07-12T05:00:00Z",
      },
    }),
  });
  assert.equal(deferred.deferred.retry_at, "2026-07-12T05:00:00.000Z");
  assert.equal(deferred.deferred.continuation, " session-123 ");
});

test("validateWorkerExecution rejects malformed envelopes", () => {
  const valid = {
    schema: WORKER_EXECUTION_SCHEMA,
    result: { status: "success" },
    deferred: null,
    session: completedSession(),
  };

  assert.throws(
    () => validateWorkerExecution({ ...valid, extra: true }),
    /contain exactly/,
  );
  assert.throws(
    () => validateWorkerExecution({ ...valid, deferred: {
      kind: "capacity",
      retry_at: "2026-07-12T05:00:00Z",
      continuation: "resume",
    } }),
    /exactly one/,
  );
  assert.throws(
    () => validateWorkerExecution({
      ...valid,
      session: completedSession({ observed_at: "not-a-date" }),
    }),
    /ISO timestamp/,
  );
  assert.throws(
    () => validateWorkerExecution({
      ...valid,
      session: completedSession({ cost_usd: Number.POSITIVE_INFINITY }),
    }),
    /finite non-negative/,
  );
  assert.throws(
    () =>
      validateWorkerExecution({
        ...valid,
        session: completedSession({
          capacity: {
            status: "allowed_warning",
            utilization: 82.5,
            resets_at: "2026-07-12T05:00:00Z",
          },
        }),
      }),
    /0 to 1/,
  );
});
