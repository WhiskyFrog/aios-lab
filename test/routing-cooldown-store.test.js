import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CandidateCooldownStore,
  CandidateCooldownStoreConflictError,
  CandidateCooldownStoreError,
  candidateCooldownsPath,
} from "../src/routing-cooldown-store.js";
import {
  CANDIDATE_COOLDOWNS_SCHEMA,
  CandidateCooldownError,
} from "../src/routing-cooldowns.js";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-cooldown-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = candidateCooldownsPath(root);
  return { root, filePath, store: new CandidateCooldownStore(filePath) };
}

test("candidateCooldownsPath resolves under .aios/runtime", async () => {
  assert.equal(
    candidateCooldownsPath("/repo"),
    path.join("/repo", ".aios", "runtime", "candidate-cooldowns.json"),
  );
});

test("a missing store loads as empty state", async (t) => {
  const { store } = await repository(t);
  const state = await store.load();
  assert.deepEqual(state.schema, CANDIDATE_COOLDOWNS_SCHEMA);
  assert.equal(state.updated_at, null);
  assert.deepEqual(state.cooldowns, []);
  assert.equal(state.raw, null);
});

test("recordCooldown creates a persisted, atomically written record", async (t) => {
  const { store, filePath } = await repository(t);
  const snapshot = await store.load();
  const state = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T01:00:00.000Z",
    reason_code: "capacity",
    evidence: "capacity exhausted",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  assert.deepEqual(state.cooldowns, [
    {
      candidate: "claude-lower",
      retry_at: "2026-07-16T01:00:00.000Z",
      reason_code: "capacity",
      evidence: "capacity exhausted",
    },
  ]);
  assert.equal(state.updated_at, "2026-07-16T00:00:00.000Z");
  const onDisk = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(onDisk, {
    schema: CANDIDATE_COOLDOWNS_SCHEMA,
    updated_at: "2026-07-16T00:00:00.000Z",
    cooldowns: state.cooldowns,
  });
});

test("recordCooldown sanitizes evidence the same way routing-ledger diagnostics are sanitized", async (t) => {
  const { store } = await repository(t);
  const snapshot = await store.load();
  const state = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T01:00:00.000Z",
    reason_code: "capacity",
    evidence: "token=abc123456789 at /home/djejg/orca/aios-lab failed",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  // sanitizeCandidateCooldownEvidence redacts token=/secret=/etc the same way
  // routing-ledger.js's normalizeFailureReason does, including its literal
  // (uncaptured) "$1=[redacted]" replacement text.
  assert.equal(state.cooldowns[0].evidence, "$1=[redacted] at [path] failed");
});

test("recordCooldown refreshes an existing candidate's cooldown and prunes other expired entries", async (t) => {
  const { store } = await repository(t);
  let snapshot = await store.load();
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T00:05:00.000Z",
    reason_code: "capacity",
    evidence: "first cooldown",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "codex-lower",
    retry_at: "2026-07-16T00:10:00.000Z",
    reason_code: "capacity",
    evidence: "second cooldown",
    observed_at: "2026-07-16T00:00:00.000Z",
  });

  // Refresh claude-lower's cooldown to a later retry_at at an observation
  // time after codex-lower's own retry_at has already passed: the refresh
  // both upserts claude-lower and drops the now-expired codex-lower entry
  // from the persisted file.
  const state = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T01:00:00.000Z",
    reason_code: "capacity",
    evidence: "refreshed cooldown",
    observed_at: "2026-07-16T00:15:00.000Z",
  });
  assert.deepEqual(
    state.cooldowns.map(({ candidate, retry_at, evidence }) => ({ candidate, retry_at, evidence })),
    [{ candidate: "claude-lower", retry_at: "2026-07-16T01:00:00.000Z", evidence: "refreshed cooldown" }],
  );
});

test("clearCooldown removes exactly the named candidate and is an idempotent no-op when absent", async (t) => {
  const { store } = await repository(t);
  let snapshot = await store.load();
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T01:00:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown a",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "codex-lower",
    retry_at: "2026-07-16T02:00:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown b",
    observed_at: "2026-07-16T00:00:00.000Z",
  });

  let state = await store.clearCooldown(snapshot, "claude-lower", "2026-07-16T00:30:00.000Z");
  assert.deepEqual(
    state.cooldowns.map(({ candidate }) => candidate),
    ["codex-lower"],
  );

  // Idempotent no-op: clearing an already-absent candidate exits cleanly
  // and does not disturb the remaining active cooldown.
  state = await store.clearCooldown(state, "claude-lower", "2026-07-16T00:31:00.000Z");
  assert.deepEqual(
    state.cooldowns.map(({ candidate }) => candidate),
    ["codex-lower"],
  );
});

test("clearCooldown also prunes other cooldowns expired as of the observation time", async (t) => {
  const { store } = await repository(t);
  let snapshot = await store.load();
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T00:05:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown a",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "codex-lower",
    retry_at: "2026-07-16T02:00:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown b",
    observed_at: "2026-07-16T00:00:00.000Z",
  });

  // Clearing an unrelated (already-absent) candidate at a later observation
  // time still prunes claude-lower's now-expired entry from the file.
  const state = await store.clearCooldown(snapshot, "nonexistent-candidate", "2026-07-16T01:00:00.000Z");
  assert.deepEqual(
    state.cooldowns.map(({ candidate }) => candidate),
    ["codex-lower"],
  );
});

test("activeCooldowns excludes expired entries as a read-only projection", async (t) => {
  const { store, filePath } = await repository(t);
  let snapshot = await store.load();
  snapshot = await store.recordCooldown(snapshot, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T00:05:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown a",
    observed_at: "2026-07-16T00:00:00.000Z",
  });
  await store.recordCooldown(snapshot, {
    candidate: "codex-lower",
    retry_at: "2026-07-16T02:00:00.000Z",
    reason_code: "capacity",
    evidence: "cooldown b",
    observed_at: "2026-07-16T00:00:00.000Z",
  });

  const beforeRead = await readFile(filePath, "utf8");
  const active = await store.activeCooldowns("2026-07-16T01:00:00.000Z");
  assert.deepEqual(
    active.map(({ candidate }) => candidate),
    ["codex-lower"],
  );
  // A read never writes: claude-lower's now-expired entry is still on disk
  // until a later write against this store participates in pruning it.
  assert.equal(await readFile(filePath, "utf8"), beforeRead);
  assert.match(beforeRead, /claude-lower/);
});

test("a stale snapshot fails closed with a conflict instead of clobbering a concurrent write", async (t) => {
  const { store } = await repository(t);
  const snapshot = await store.load();
  await store.recordCooldown(snapshot, {
    candidate: "codex-lower",
    retry_at: "2026-07-16T02:00:00.000Z",
    reason_code: "capacity",
    evidence: "written by another caller",
    observed_at: "2026-07-16T00:00:00.000Z",
  });

  await assert.rejects(
    store.recordCooldown(snapshot, {
      candidate: "claude-lower",
      retry_at: "2026-07-16T02:00:00.000Z",
      reason_code: "capacity",
      evidence: "stale writer",
      observed_at: "2026-07-16T00:00:00.000Z",
    }),
    CandidateCooldownStoreConflictError,
  );
  const state = await store.load();
  assert.deepEqual(
    state.cooldowns.map(({ candidate }) => candidate),
    ["codex-lower"],
  );
});

test("an exclusive lock file already present fails a write closed as a conflict", async (t) => {
  const { store, filePath } = await repository(t);
  const snapshot = await store.load();
  await mkdir(path.dirname(filePath), { recursive: true });
  const lock = await open(`${filePath}.lock`, "wx");
  try {
    await assert.rejects(
      store.recordCooldown(snapshot, {
        candidate: "claude-lower",
        retry_at: "2026-07-16T01:00:00.000Z",
        reason_code: "capacity",
        evidence: "blocked writer",
        observed_at: "2026-07-16T00:00:00.000Z",
      }),
      CandidateCooldownStoreConflictError,
    );
  } finally {
    await lock.close();
  }
});

test("malformed on-disk content is a named error, never silently discarded or repaired", async (t) => {
  const { store, filePath } = await repository(t);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "{ not valid json", "utf8");
  await assert.rejects(store.load(), CandidateCooldownStoreError);

  // Structurally valid JSON that fails aios.candidate-cooldowns/v1 schema
  // validation surfaces the schema module's own named error rather than
  // being repaired or treated as empty state.
  await writeFile(filePath, JSON.stringify({ schema: CANDIDATE_COOLDOWNS_SCHEMA }), "utf8");
  await assert.rejects(store.load(), CandidateCooldownError);
});
