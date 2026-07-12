import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicReplace } from "./documents.js";

export const WORKER_EXECUTION_SCHEMA = "aios.worker-execution/v1";

const LEDGER_SCHEMA = "aios.sessions/v1";
const OUTCOMES = new Set(["completed", "failed", "capacity_deferred"]);
const CAPACITY_STATUSES = new Set([
  "allowed",
  "allowed_warning",
  "rejected",
]);
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function exactObject(value, keys, label) {
  if (!isObject(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function opaqueString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    fail(`${label} must be a string or null`);
  }
  return value;
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") {
    fail(`${label} must be an ISO timestamp`);
  }
  const match = TIMESTAMP.exec(value);
  if (!match) {
    fail(`${label} must be an ISO timestamp`);
  }

  const [, year, month, day, hour, minute, second, , zone] = match;
  const numericMonth = Number(month);
  const daysInMonth = new Date(
    Date.UTC(Number(year), numericMonth, 0),
  ).getUTCDate();
  if (
    numericMonth < 1 ||
    numericMonth > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    fail(`${label} must be an ISO timestamp`);
  }
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) {
      fail(`${label} must be an ISO timestamp`);
    }
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(`${label} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function validateUsage(value, label) {
  if (value === null) {
    return null;
  }
  exactObject(
    value,
    [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ],
    label,
  );
  return {
    input_tokens: finiteNonNegative(value.input_tokens, `${label}.input_tokens`),
    output_tokens: finiteNonNegative(value.output_tokens, `${label}.output_tokens`),
    cache_creation_input_tokens: finiteNonNegative(
      value.cache_creation_input_tokens,
      `${label}.cache_creation_input_tokens`,
    ),
    cache_read_input_tokens: finiteNonNegative(
      value.cache_read_input_tokens,
      `${label}.cache_read_input_tokens`,
    ),
  };
}

function validateCapacity(value, label) {
  if (value === null) {
    return null;
  }
  exactObject(value, ["status", "utilization", "resets_at"], label);
  if (!CAPACITY_STATUSES.has(value.status)) {
    fail(`${label}.status has an unknown value: ${String(value.status)}`);
  }
  if (
    value.utilization !== null &&
    (typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) ||
      value.utilization < 0 ||
      value.utilization > 1)
  ) {
    fail(`${label}.utilization must be a number from 0 to 1 or null`);
  }
  return {
    status: value.status,
    utilization: value.utilization,
    resets_at: optionalTimestamp(value.resets_at, `${label}.resets_at`),
  };
}

function validateSession(value, label = "Worker execution session") {
  exactObject(
    value,
    [
      "id",
      "task",
      "role",
      "model",
      "started_at",
      "observed_at",
      "outcome",
      "usage",
      "cost_usd",
      "capacity",
    ],
    label,
  );
  if (!OUTCOMES.has(value.outcome)) {
    fail(`${label}.outcome has an unknown value: ${String(value.outcome)}`);
  }
  return {
    id: opaqueString(value.id, `${label}.id`),
    task: nonEmptyString(value.task, `${label}.task`),
    role: nonEmptyString(value.role, `${label}.role`),
    model: optionalString(value.model, `${label}.model`),
    started_at: timestamp(value.started_at, `${label}.started_at`),
    observed_at: timestamp(value.observed_at, `${label}.observed_at`),
    outcome: value.outcome,
    usage: validateUsage(value.usage, `${label}.usage`),
    cost_usd:
      value.cost_usd === null
        ? null
        : finiteNonNegative(value.cost_usd, `${label}.cost_usd`),
    capacity: validateCapacity(value.capacity, `${label}.capacity`),
  };
}

function validateDeferred(value) {
  if (value === null) {
    return null;
  }
  exactObject(value, ["kind", "retry_at", "continuation"], "Worker deferral");
  if (value.kind !== "capacity") {
    fail("Worker deferral.kind must be capacity");
  }
  return {
    kind: "capacity",
    retry_at: timestamp(value.retry_at, "Worker deferral.retry_at"),
    continuation: opaqueString(
      value.continuation,
      "Worker deferral.continuation",
    ),
  };
}

export function validateWorkerExecution(value) {
  exactObject(
    value,
    ["schema", "result", "deferred", "session"],
    "Worker execution",
  );
  if (value.schema !== WORKER_EXECUTION_SCHEMA) {
    fail(`Worker execution schema must be ${WORKER_EXECUTION_SCHEMA}`);
  }
  if (value.result !== null && !isObject(value.result)) {
    fail("Worker execution.result must be an object or null");
  }

  const deferred = validateDeferred(value.deferred);
  const hasResult = value.result !== null;
  const hasDeferred = deferred !== null;
  if (hasResult === hasDeferred) {
    fail("Worker execution must contain exactly one result or deferral");
  }

  const session = validateSession(value.session);
  if (hasResult && value.result.status !== "success" && value.result.status !== "failure") {
    fail("Worker execution.result.status must be success or failure");
  }
  const expectedOutcome = hasDeferred
    ? "capacity_deferred"
    : value.result.status === "failure"
      ? "failed"
      : "completed";
  if (session.outcome !== expectedOutcome) {
    fail("Worker execution session outcome does not match its result or deferral");
  }

  return {
    schema: WORKER_EXECUTION_SCHEMA,
    result: hasResult ? { ...value.result } : null,
    deferred,
    session,
  };
}

function validateLedgerRow(value, index) {
  const label = `Session ledger row ${index}`;
  exactObject(
    value,
    [
      "id",
      "task",
      "role",
      "model",
      "first_seen_at",
      "last_seen_at",
      "invocations",
      "outcome",
      "usage",
      "cost_usd",
      "capacity",
    ],
    label,
  );
  if (!Number.isInteger(value.invocations) || value.invocations < 1) {
    fail(`${label}.invocations must be a positive integer`);
  }
  if (!OUTCOMES.has(value.outcome)) {
    fail(`${label}.outcome has an unknown value: ${String(value.outcome)}`);
  }
  const firstSeen = timestamp(value.first_seen_at, `${label}.first_seen_at`);
  const lastSeen = timestamp(value.last_seen_at, `${label}.last_seen_at`);
  if (firstSeen > lastSeen) {
    fail(`${label}.first_seen_at cannot be after last_seen_at`);
  }
  return {
    id: opaqueString(value.id, `${label}.id`),
    task: nonEmptyString(value.task, `${label}.task`),
    role: nonEmptyString(value.role, `${label}.role`),
    model: optionalString(value.model, `${label}.model`),
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    invocations: value.invocations,
    outcome: value.outcome,
    usage: validateUsage(value.usage, `${label}.usage`),
    cost_usd:
      value.cost_usd === null
        ? null
        : finiteNonNegative(value.cost_usd, `${label}.cost_usd`),
    capacity: validateCapacity(value.capacity, `${label}.capacity`),
  };
}

function compareRows(left, right) {
  return (
    left.first_seen_at.localeCompare(right.first_seen_at) ||
    left.id.localeCompare(right.id)
  );
}

function validateLedger(value) {
  exactObject(value, ["schema", "updated_at", "sessions"], "Session ledger");
  if (value.schema !== LEDGER_SCHEMA) {
    fail(`Session ledger schema must be ${LEDGER_SCHEMA}`);
  }
  const updatedAt = optionalTimestamp(value.updated_at, "Session ledger.updated_at");
  if (!Array.isArray(value.sessions)) {
    fail("Session ledger.sessions must be an array");
  }
  const sessions = value.sessions.map(validateLedgerRow);
  const ids = new Set();
  for (let index = 0; index < sessions.length; index += 1) {
    const row = sessions[index];
    if (ids.has(row.id)) {
      fail(`Session ledger contains duplicate id ${row.id}`);
    }
    ids.add(row.id);
    if (index > 0 && compareRows(sessions[index - 1], row) > 0) {
      fail("Session ledger rows must be sorted by first_seen_at then id");
    }
  }
  return { schema: LEDGER_SCHEMA, updated_at: updatedAt, sessions };
}

function emptyLedger() {
  return { schema: LEDGER_SCHEMA, updated_at: null, sessions: [] };
}

function rowFromSession(session) {
  return {
    id: session.id,
    task: session.task,
    role: session.role,
    model: session.model,
    first_seen_at: session.started_at,
    last_seen_at: session.observed_at,
    invocations: 1,
    outcome: session.outcome,
    usage: session.usage,
    cost_usd: session.cost_usd,
    capacity: session.capacity,
  };
}

function mergeUsage(left, right) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_creation_input_tokens:
      left.cache_creation_input_tokens + right.cache_creation_input_tokens,
    cache_read_input_tokens:
      left.cache_read_input_tokens + right.cache_read_input_tokens,
  };
}

function mergeCost(left, right) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left + right;
}

export class SessionLedger {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyLedger();
      }
      throw error;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new TypeError(`Session ledger must be valid JSON: ${error.message}`);
    }
    return validateLedger(value);
  }

  async record(value) {
    const session = validateSession(value, "Session record");
    const ledger = await this.load();
    const index = ledger.sessions.findIndex((row) => row.id === session.id);

    if (index === -1) {
      ledger.sessions.push(rowFromSession(session));
    } else {
      const current = ledger.sessions[index];
      if (current.task !== session.task || current.role !== session.role) {
        fail(
          `Session ${session.id} cannot change task or role in the session ledger`,
        );
      }
      const incoming = rowFromSession(session);
      const incomingIsLatest = incoming.last_seen_at >= current.last_seen_at;
      const latest = incomingIsLatest ? incoming : current;
      const earlier = incomingIsLatest ? current : incoming;
      ledger.sessions[index] = {
        ...latest,
        model: latest.model ?? earlier.model,
        usage: mergeUsage(current.usage, incoming.usage),
        cost_usd: mergeCost(current.cost_usd, incoming.cost_usd),
        capacity: latest.capacity ?? earlier.capacity,
        first_seen_at:
          incoming.first_seen_at < current.first_seen_at
            ? incoming.first_seen_at
            : current.first_seen_at,
        last_seen_at:
          incoming.last_seen_at > current.last_seen_at
            ? incoming.last_seen_at
            : current.last_seen_at,
        invocations: current.invocations + 1,
      };
    }

    ledger.sessions.sort(compareRows);
    ledger.updated_at =
      ledger.updated_at === null || session.observed_at > ledger.updated_at
        ? session.observed_at
        : ledger.updated_at;
    const normalized = validateLedger(ledger);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicReplace(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }
}
