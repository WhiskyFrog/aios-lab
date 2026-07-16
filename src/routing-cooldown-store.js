import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { atomicReplace } from "./documents.js";
import {
  CANDIDATE_COOLDOWNS_SCHEMA,
  sanitizeCandidateCooldownEvidence,
  validateCandidateCooldownRecord,
  validateCandidateCooldownsDocument,
} from "./routing-cooldowns.js";

// Atomic, machine-local per-candidate cooldown store, mirroring the
// discipline RoutingDecisionLedger already applies to
// .aios/runtime/routing-decisions.json: full schema validation on every
// load, atomic replace guarded by an exclusive lock file, and a
// snapshot/compare-and-swap check so two writers never silently clobber each
// other. A missing file is empty state; malformed content is a named error
// and is never silently discarded or repaired. This store is independent of
// the routing-decision ledger: clearing or expiring a cooldown never
// touches a decision row.

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function candidateCooldownsPath(root) {
  return path.join(path.resolve(root), ".aios", "runtime", "candidate-cooldowns.json");
}

export class CandidateCooldownStoreError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "CandidateCooldownStoreError";
  }
}

export class CandidateCooldownStoreConflictError extends CandidateCooldownStoreError {
  constructor(message = "Candidate cooldown store changed after it was read") {
    super(message);
    this.name = "CandidateCooldownStoreConflictError";
  }
}

function fail(label, message) {
  throw new CandidateCooldownStoreError(`${label}: ${message}`);
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function sortedCooldowns(records) {
  return [...records].sort((left, right) => compareText(left.candidate, right.candidate));
}

export class CandidateCooldownStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async #currentRaw() {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  // A missing store is empty state. Malformed content is a named error;
  // nothing here ever overwrites it automatically.
  async load() {
    const raw = await this.#currentRaw();
    if (raw === null) {
      return deepFreeze({
        schema: CANDIDATE_COOLDOWNS_SCHEMA,
        updated_at: null,
        cooldowns: [],
        raw: null,
      });
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new CandidateCooldownStoreError(
        `Candidate cooldown store must be valid JSON: ${error.message}`,
        { cause: error },
      );
    }
    return deepFreeze({ ...validateCandidateCooldownsDocument(value), raw });
  }

  async #commit(snapshot, document) {
    if (snapshot === null || typeof snapshot !== "object" || !("raw" in snapshot)) {
      fail("cooldown store snapshot", "must be loaded from CandidateCooldownStore.load()");
    }
    const normalized = validateCandidateCooldownsDocument(document);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CandidateCooldownStoreConflictError();
      }
      throw error;
    }
    try {
      const current = await this.#currentRaw();
      if (current !== snapshot.raw) {
        throw new CandidateCooldownStoreConflictError();
      }
      await atomicReplace(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    } finally {
      await lock.close();
      try {
        await unlink(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return this.load();
  }

  // Records or refreshes exactly one candidate's cooldown. Every write also
  // prunes any other cooldown (including a stale one for this same
  // candidate) whose retry_at is at or before observed_at, so the file
  // never grows unbounded from routine capacity recovery.
  async recordCooldown(snapshot, { candidate, retry_at, reason_code, evidence, observed_at }) {
    const observedAt = timestamp(observed_at, "observed_at");
    const record = validateCandidateCooldownRecord({
      candidate,
      retry_at,
      reason_code,
      evidence: sanitizeCandidateCooldownEvidence(evidence),
    });
    const cooldowns = sortedCooldowns([
      ...snapshot.cooldowns.filter(
        (entry) => entry.candidate !== record.candidate && entry.retry_at > observedAt,
      ),
      record,
    ]);
    return this.#commit(snapshot, {
      schema: CANDIDATE_COOLDOWNS_SCHEMA,
      updated_at: observedAt,
      cooldowns,
    });
  }

  // Removes exactly the named candidate's cooldown; an idempotent no-op
  // when it has none. Every write also prunes any other cooldown whose
  // retry_at is at or before observed_at, and is itself an atomic
  // compare-and-swap write like every other mutation of this state.
  async clearCooldown(snapshot, candidateId, observed_at) {
    const observedAt = timestamp(observed_at, "observed_at");
    const cooldowns = sortedCooldowns(
      snapshot.cooldowns.filter(
        (entry) => entry.candidate !== candidateId && entry.retry_at > observedAt,
      ),
    );
    return this.#commit(snapshot, {
      schema: CANDIDATE_COOLDOWNS_SCHEMA,
      updated_at: observedAt,
      cooldowns,
    });
  }

  // The currently active (non-expired) cooldowns as of the supplied
  // instant, sorted by candidate id. A read-only projection: pruning a
  // stale entry from the persisted file itself only happens on the next
  // write that store participates in.
  async activeCooldowns(asOf) {
    const observedAt = timestamp(asOf, "asOf");
    const state = await this.load();
    return deepFreeze(
      state.cooldowns
        .filter((entry) => entry.retry_at > observedAt)
        .map((entry) => ({ ...entry })),
    );
  }
}
