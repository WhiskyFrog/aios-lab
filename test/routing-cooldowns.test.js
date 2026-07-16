import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_COOLDOWNS_SCHEMA,
  CandidateCooldownError,
  sanitizeCandidateCooldownEvidence,
  validateCandidateCooldownRecord,
  validateCandidateCooldownsDocument,
} from "../src/routing-cooldowns.js";

function record(overrides = {}) {
  return {
    candidate: "claude-lower",
    retry_at: "2026-07-16T00:05:00.000Z",
    reason_code: "capacity",
    evidence: "capacity exhausted after 3 consecutive attempts",
    ...overrides,
  };
}

test("a valid cooldown record normalizes the retry_at timestamp", () => {
  const validated = validateCandidateCooldownRecord(record());
  assert.deepEqual(validated, {
    candidate: "claude-lower",
    retry_at: "2026-07-16T00:05:00.000Z",
    reason_code: "capacity",
    evidence: "capacity exhausted after 3 consecutive attempts",
  });
});

test("a cooldown record rejects a missing or unrecognized field", () => {
  const { candidate, ...missingCandidate } = record();
  assert.throws(() => validateCandidateCooldownRecord(missingCandidate), CandidateCooldownError);
  assert.throws(
    () => validateCandidateCooldownRecord({ ...record(), extra: true }),
    CandidateCooldownError,
  );
});

test("a cooldown record rejects a malformed candidate id or retry_at", () => {
  assert.throws(
    () => validateCandidateCooldownRecord(record({ candidate: "Claude-Lower" })),
    /must be a lowercase identifier/,
  );
  assert.throws(
    () => validateCandidateCooldownRecord(record({ retry_at: "not-a-timestamp" })),
    /must be an ISO timestamp/,
  );
});

test("a cooldown record rejects an unknown reason code", () => {
  assert.throws(
    () => validateCandidateCooldownRecord(record({ reason_code: "not_a_real_code" })),
    /has an unknown value/,
  );
});

test("a cooldown record rejects evidence that is empty, overlong, or not already sanitized", () => {
  assert.throws(
    () => validateCandidateCooldownRecord(record({ evidence: "" })),
    CandidateCooldownError,
  );
  assert.throws(
    () => validateCandidateCooldownRecord(record({ evidence: "x".repeat(241) })),
    CandidateCooldownError,
  );
  assert.throws(
    () => validateCandidateCooldownRecord(record({ evidence: "token=abc123456789 failed" })),
    CandidateCooldownError,
  );
  assert.throws(
    () => validateCandidateCooldownRecord(record({ evidence: "/home/djejg/secret/file failed" })),
    CandidateCooldownError,
  );
});

test("sanitizeCandidateCooldownEvidence redacts secrets and local paths the same way routing-ledger.js does", () => {
  assert.equal(
    sanitizeCandidateCooldownEvidence("Bearer sekret123456 token=abc123456789"),
    "Bearer [redacted] $1=[redacted]",
  );
  assert.equal(
    sanitizeCandidateCooldownEvidence("failed at /home/djejg/orca/aios-lab"),
    "failed at [path]",
  );
});

test("a candidate-cooldowns document validates schema, ordering, and duplicate candidates", () => {
  const document = validateCandidateCooldownsDocument({
    schema: CANDIDATE_COOLDOWNS_SCHEMA,
    updated_at: "2026-07-16T00:05:00.000Z",
    cooldowns: [record({ candidate: "claude-lower" }), record({ candidate: "codex-lower" })],
  });
  assert.equal(document.cooldowns.length, 2);

  assert.throws(
    () =>
      validateCandidateCooldownsDocument({
        schema: "aios.candidate-cooldowns/v2",
        updated_at: null,
        cooldowns: [],
      }),
    /must be aios\.candidate-cooldowns\/v1/,
  );
  assert.throws(
    () =>
      validateCandidateCooldownsDocument({
        schema: CANDIDATE_COOLDOWNS_SCHEMA,
        updated_at: null,
        cooldowns: [record({ candidate: "codex-lower" }), record({ candidate: "claude-lower" })],
      }),
    /must be ordered by candidate id/,
  );
  assert.throws(
    () =>
      validateCandidateCooldownsDocument({
        schema: CANDIDATE_COOLDOWNS_SCHEMA,
        updated_at: null,
        cooldowns: [record({ candidate: "claude-lower" }), record({ candidate: "claude-lower" })],
      }),
    /contains duplicate candidate/,
  );
});
