// Strict schema for a machine-local per-candidate cooldown record: a catalog
// candidate id, the ISO instant it may be reselected, and bounded sanitized
// evidence tied to the failure reason code that justified the cooldown. This
// module owns only the schema and its validation - no file I/O, persistence,
// or clock read. A later Task wires a store and expiry pruning around it;
// src/routing-policy.js consumes validated records of this shape as a plain
// function input, exactly like it already does for `history` and `recovery`.

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const EVIDENCE_LIMIT = 240;

// The same failure-reason vocabulary src/routing-ledger.js's
// FAILURE_REASON_CODES exposes, duplicated rather than imported:
// routing-ledger.js depends on routing-policy.js, and routing-policy.js
// depends on this module, so importing routing-ledger.js here would create a
// cycle.
const REASON_CODES = new Set([
  "capacity",
  "timeout",
  "provider_error",
  "test_failure",
  "review_rejected",
  "duplicate_evidence",
  "context_failure",
  "operator_override",
  "no_eligible_candidate",
  "provider_failure",
  "verification_failed",
  "context_insufficient",
  "repeated_evidence",
  "worker_reported_failure",
  "invalid_result",
  "routing_exhausted",
]);

export const CANDIDATE_COOLDOWNS_SCHEMA = "aios.candidate-cooldowns/v1";

export class CandidateCooldownError extends TypeError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "CandidateCooldownError";
  }
}

function fail(label, message) {
  throw new CandidateCooldownError(`${label}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, label) {
  if (!isObject(value)) {
    fail(label, "must be an object");
  }
  for (const name of required) {
    if (!Object.hasOwn(value, name)) {
      fail(label, `is missing required field ${name}`);
    }
  }
  for (const name of Object.keys(value)) {
    if (!required.includes(name)) {
      fail(`${label}.${name}`, "is not allowed");
    }
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(label, `must be a lowercase identifier, got ${String(value)}`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    fail(label, "must be an ISO timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(label, "must be an ISO timestamp");
  }
  return new Date(milliseconds).toISOString();
}

// The same redaction rules src/routing-ledger.js's normalizeFailureReason
// applies to dispatch diagnostics: secrets and local paths are redacted,
// control characters collapse to spaces, and the result is bounded.
export function sanitizeCandidateCooldownEvidence(evidence) {
  return String(evidence)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[path]")
    .trim()
    .slice(0, EVIDENCE_LIMIT);
}

export function validateCandidateCooldownRecord(value, label = "cooldown") {
  exactKeys(value, ["candidate", "retry_at", "reason_code", "evidence"], label);
  const candidate = identifier(value.candidate, `${label}.candidate`);
  const retryAt = timestamp(value.retry_at, `${label}.retry_at`);
  if (!REASON_CODES.has(value.reason_code)) {
    fail(`${label}.reason_code`, `has an unknown value: ${String(value.reason_code)}`);
  }
  if (typeof value.evidence !== "string") {
    fail(`${label}.evidence`, "must be a string");
  }
  if (CONTROL_CHARACTERS.test(value.evidence)) {
    fail(`${label}.evidence`, "must not contain control characters");
  }
  const sanitized = sanitizeCandidateCooldownEvidence(value.evidence);
  if (value.evidence.length === 0 || value.evidence !== sanitized) {
    fail(
      `${label}.evidence`,
      `must be a non-empty, normalized, sanitized string of at most ${EVIDENCE_LIMIT} characters`,
    );
  }
  return {
    candidate,
    retry_at: retryAt,
    reason_code: value.reason_code,
    evidence: sanitized,
  };
}

export function validateCandidateCooldownsDocument(value, label = "Candidate cooldowns") {
  exactKeys(value, ["schema", "updated_at", "cooldowns"], label);
  if (value.schema !== CANDIDATE_COOLDOWNS_SCHEMA) {
    fail(`${label}.schema`, `must be ${CANDIDATE_COOLDOWNS_SCHEMA}`);
  }
  const updatedAt =
    value.updated_at === null ? null : timestamp(value.updated_at, `${label}.updated_at`);
  if (!Array.isArray(value.cooldowns)) {
    fail(`${label}.cooldowns`, "must be an array");
  }
  const cooldowns = value.cooldowns.map((entry, index) =>
    validateCandidateCooldownRecord(entry, `${label}.cooldowns[${index}]`),
  );
  const seen = new Set();
  cooldowns.forEach((record, index) => {
    if (seen.has(record.candidate)) {
      fail(`${label}.cooldowns`, `contains duplicate candidate ${record.candidate}`);
    }
    seen.add(record.candidate);
    if (index > 0 && cooldowns[index - 1].candidate >= record.candidate) {
      fail(`${label}.cooldowns`, "must be ordered by candidate id");
    }
  });
  return { schema: CANDIDATE_COOLDOWNS_SCHEMA, updated_at: updatedAt, cooldowns };
}
