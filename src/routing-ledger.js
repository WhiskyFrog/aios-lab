import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { atomicReplace } from "./documents.js";
import { isSafeModelIdentifier } from "./routing.js";
import {
  decisionKeyString,
  OVERRIDE_DISPLACEABLE_REASON_CODES,
  overrideDisplacedRationale,
  SELECTION_REASON_CODES,
  validateDecisionKey,
} from "./routing-policy.js";

// Atomic, append-only routing-decision ledger. Selection stays pure in
// routing-policy.js; this adapter owns persistence, compare-and-swap
// conflicts, idempotent resolution, and sanitized read projections.

export const ROUTING_DECISIONS_SCHEMA = "aios.routing-decisions/v1";

export function routingDecisionsPath(root) {
  return path.join(path.resolve(root), ".aios", "runtime", "routing-decisions.json");
}

// Dispatch/outcome states and their forward-only ordering. A terminal state
// is never rewritten.
const STATUS_RANK = Object.freeze({
  selected: 0,
  dispatched: 1,
  completed: 2,
  failed: 2,
  superseded: 2,
});
export const DECISION_STATUSES = Object.freeze(Object.keys(STATUS_RANK));

// The complete failure vocabulary. Raw provider errors are never stored;
// callers normalize them to one code plus a bounded, sanitized diagnostic.
export const FAILURE_REASON_CODES = Object.freeze([
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
export const ROUTING_EVENT_KINDS = Object.freeze([
  "launch",
  "capacity_pause",
  "failure",
  "fallback",
  "escalation",
  "completion",
  "exhausted",
]);
const FAILURE_CODES = new Set(FAILURE_REASON_CODES);
const EVENT_KINDS = new Set(ROUTING_EVENT_KINDS);
// Reason codes that advance a route by escalation rather than fallback,
// mirroring the dispatch adapter's recovery classification.
const ESCALATION_ADVANCE_CODES = new Set([
  "verification_failed",
  "context_insufficient",
  "repeated_evidence",
]);
const EVENTS_WITHOUT_REASON = new Set(["launch", "completion"]);
const GATE_CODES = new Set(SELECTION_REASON_CODES);
const DIAGNOSTIC_LIMIT = 240;
const SOURCE_LABEL_LIMIT = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_ID = /^task-[0-9]{4,}$/;
const TASK_SELECTOR = /^(?:\*|task-[0-9]{4,})$/;
const ROUTED_ROLES = new Set(["implementer", "reviewer"]);
const OVERRIDE_SOURCES = new Set(["cli", "config"]);
const OVERRIDE_DISPLACEABLE = new Set(OVERRIDE_DISPLACEABLE_REASON_CODES);
const WORK_KINDS = new Set(["planning", "implementation", "unknown"]);
const BANDS = new Set(["low", "medium", "high", "unknown"]);
const CONTEXT_BANDS = new Set(["small", "medium", "large"]);
const VERIFICATION = new Set(["objective", "subjective", "unknown"]);
const LOWER_TIER_REASONS = new Set([
  "role_not_implementer",
  "work_not_bounded_implementation",
  "complexity_not_low",
  "risk_not_low",
  "context_not_bounded",
  "capabilities_not_explicit",
  "verification_not_objective",
  "unresolved_failure_history",
  "safety_evidence_uncertain",
]);
const APPROVALS = new Set(["not_required", "required", "approved", "rejected"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const WORKLOAD_SOURCE_KEYS = Object.freeze([
  "task_id",
  "role",
  "work_kind",
  "parent_plan",
  "complexity",
  "risk",
  "context_size",
  "required_capabilities",
  "verification_burden",
  "budgets",
  "approval",
  "retry",
  "history",
  "minimum_tier",
  "uncertainty_flags",
  "lower_tier",
  "diagnostics",
]);
const HINT_SOURCE = /^routing\.hints\.(?:task:task-[0-9]{4,}|plan:[a-z0-9][a-z0-9._-]*)$/;

export class RoutingLedgerError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "RoutingLedgerError";
  }
}

export class RoutingLedgerConflictError extends RoutingLedgerError {
  constructor(message = "Routing decision ledger changed after it was read") {
    super(message);
    this.name = "RoutingLedgerConflictError";
  }
}

function fail(label, message) {
  throw new RoutingLedgerError(`${label}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function exactKeys(value, required, label) {
  if (!isObject(value)) {
    fail(label, "must be an object");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(label, `is missing required field ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) {
      fail(`${label}.${key}`, "is not allowed");
    }
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(label, `must be a lowercase identifier, got ${String(value)}`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(label, "must be a non-empty string");
  }
  return value;
}

function modelIdentifier(value, label) {
  if (!isSafeModelIdentifier(value)) {
    fail(label, "must be a bounded, credential-safe provider model identifier");
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) {
    fail(label, `has an unknown value: ${String(value)}`);
  }
  return value;
}

function boundedLabel(value, label, limit) {
  nonEmptyString(value, label);
  if (value.length > limit || CONTROL_CHARACTERS.test(value)) {
    fail(label, `must be at most ${limit} sanitized characters`);
  }
  return value;
}

function sourceLabelAllowed(name, value) {
  if (HINT_SOURCE.test(value)) {
    return new Set([
      "work_kind",
      "complexity",
      "risk",
      "required_capabilities",
      "verification_burden",
      "budgets",
    ]).has(name);
  }
  const allowed = {
    task_id: ["task.metadata.id"],
    role: ["engine.active_role"],
    work_kind: ["task.plan_only_contract", "default", "conflicting_hint_and_task_contract"],
    parent_plan: ["plan_scan", "adopted_plan.execution_order"],
    complexity: ["task.structure"],
    risk: ["default", "task.approval", "history_validation", "task.retry", "review_session_history"],
    context_size: ["task.raw_utf8"],
    required_capabilities: ["default_unknown"],
    verification_burden: ["default_unknown"],
    budgets: ["routing.policy.default_budgets"],
    approval: ["task.metadata.approval"],
    retry: ["task.metadata.retry"],
    history: ["provided_review_session_history"],
    minimum_tier: ["lower_tier_gate", "routing.policy.high_tier"],
    uncertainty_flags: ["workload_evidence_validation"],
    lower_tier: ["documented_lower_tier_gate"],
    diagnostics: ["plan_and_history_validation"],
  };
  return allowed[name]?.includes(value) === true;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") {
    fail(label, "must be a boolean");
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(label, "must be a non-negative safe integer");
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(label, "must be a positive safe integer");
  }
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(label, "must be a finite number");
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

export function normalizeFailureReason(code, diagnostic = "") {
  if (!FAILURE_CODES.has(code)) {
    fail("failure reason", `has an unknown code: ${String(code)}`);
  }
  const sanitized = String(diagnostic)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[path]")
    .trim()
    .slice(0, DIAGNOSTIC_LIMIT);
  return deepFreeze({ code, diagnostic: sanitized });
}

function validateReason(value, label) {
  if (value === null) {
    return null;
  }
  exactKeys(value, ["code", "diagnostic"], label);
  if (!FAILURE_CODES.has(value.code)) {
    fail(`${label}.code`, `has an unknown value: ${String(value.code)}`);
  }
  if (typeof value.diagnostic !== "string") {
    fail(`${label}.diagnostic`, "must be a string");
  }
  const normalized = normalizeFailureReason(value.code, value.diagnostic);
  if (value.diagnostic !== normalized.diagnostic) {
    fail(
      `${label}.diagnostic`,
      `must be normalized, sanitized, and at most ${DIAGNOSTIC_LIMIT} characters`,
    );
  }
  return { code: normalized.code, diagnostic: normalized.diagnostic };
}

function validateWorkloadSummary(value, label) {
  exactKeys(
    value,
    [
      "task",
      "role",
      "work_kind",
      "parent_plan",
      "complexity",
      "risk",
      "context_band",
      "required_capabilities",
      "verification",
      "budgets",
      "approval",
      "retry",
      "history",
      "uncertainty_flags",
      "minimum_tier",
      "lower_tier",
      "sources",
      "diagnostics",
    ],
    label,
  );
  if (typeof value.task !== "string" || !TASK_ID.test(value.task)) {
    fail(`${label}.task`, "must be a Task id");
  }
  enumValue(value.role, ROUTED_ROLES, `${label}.role`);
  enumValue(value.work_kind, WORK_KINDS, `${label}.work_kind`);
  if (value.parent_plan !== null) {
    exactKeys(value.parent_plan, ["id", "profile"], `${label}.parent_plan`);
    identifier(value.parent_plan.id, `${label}.parent_plan.id`);
    identifier(value.parent_plan.profile, `${label}.parent_plan.profile`);
  }
  enumValue(value.complexity, BANDS, `${label}.complexity`);
  enumValue(value.risk, BANDS, `${label}.risk`);
  enumValue(value.context_band, CONTEXT_BANDS, `${label}.context_band`);
  if (!Array.isArray(value.required_capabilities)) {
    fail(`${label}.required_capabilities`, "must be an array");
  }
  value.required_capabilities.forEach((entry, index) =>
    identifier(entry, `${label}.required_capabilities[${index}]`),
  );
  if (new Set(value.required_capabilities).size !== value.required_capabilities.length) {
    fail(`${label}.required_capabilities`, "must not contain duplicates");
  }
  enumValue(value.verification, VERIFICATION, `${label}.verification`);
  exactKeys(value.budgets, ["cost", "latency"], `${label}.budgets`);
  identifier(value.budgets.cost, `${label}.budgets.cost`);
  identifier(value.budgets.latency, `${label}.budgets.latency`);
  if (!APPROVALS.has(value.approval)) {
    fail(`${label}.approval`, `has an unknown value: ${String(value.approval)}`);
  }
  exactKeys(value.retry, ["count", "limit"], `${label}.retry`);
  nonNegativeInteger(value.retry.count, `${label}.retry.count`);
  nonNegativeInteger(value.retry.limit, `${label}.retry.limit`);
  if (value.retry.count > value.retry.limit) {
    fail(`${label}.retry`, "count cannot exceed limit");
  }
  exactKeys(
    value.history,
    ["reviews_total", "changes_requested", "sessions_failed", "capacity_deferred"],
    `${label}.history`,
  );
  for (const [name, count] of Object.entries(value.history)) {
    nonNegativeInteger(count, `${label}.history.${name}`);
  }
  if (value.history.changes_requested > value.history.reviews_total) {
    fail(`${label}.history.changes_requested`, "cannot exceed reviews_total");
  }
  if (!Array.isArray(value.uncertainty_flags)) {
    fail(`${label}.uncertainty_flags`, "must be an array");
  }
  value.uncertainty_flags.forEach((entry, index) =>
    identifier(entry, `${label}.uncertainty_flags[${index}]`),
  );
  if (new Set(value.uncertainty_flags).size !== value.uncertainty_flags.length) {
    fail(`${label}.uncertainty_flags`, "must not contain duplicates");
  }
  identifier(value.minimum_tier, `${label}.minimum_tier`);
  exactKeys(value.lower_tier, ["eligible", "rejection_reasons"], `${label}.lower_tier`);
  booleanValue(value.lower_tier.eligible, `${label}.lower_tier.eligible`);
  if (!Array.isArray(value.lower_tier.rejection_reasons)) {
    fail(`${label}.lower_tier.rejection_reasons`, "must be an array");
  }
  value.lower_tier.rejection_reasons.forEach((entry, index) =>
    enumValue(entry, LOWER_TIER_REASONS, `${label}.lower_tier.rejection_reasons[${index}]`),
  );
  if (
    new Set(value.lower_tier.rejection_reasons).size !==
    value.lower_tier.rejection_reasons.length
  ) {
    fail(`${label}.lower_tier.rejection_reasons`, "must not contain duplicates");
  }
  if (
    value.lower_tier.eligible !==
    (value.lower_tier.rejection_reasons.length === 0)
  ) {
    fail(`${label}.lower_tier`, "eligible must match an empty rejection list");
  }
  exactKeys(
    value.diagnostics,
    ["strict_planning_contract", "plan_errors", "history_errors"],
    `${label}.diagnostics`,
  );
  booleanValue(
    value.diagnostics.strict_planning_contract,
    `${label}.diagnostics.strict_planning_contract`,
  );
  nonNegativeInteger(value.diagnostics.plan_errors, `${label}.diagnostics.plan_errors`);
  nonNegativeInteger(value.diagnostics.history_errors, `${label}.diagnostics.history_errors`);
  exactKeys(value.sources, WORKLOAD_SOURCE_KEYS, `${label}.sources`);
  for (const [name, source] of Object.entries(value.sources)) {
    boundedLabel(source, `${label}.sources.${name}`, SOURCE_LABEL_LIMIT);
    if (!sourceLabelAllowed(name, source)) {
      fail(`${label}.sources.${name}`, "is not a recognized normalized source label");
    }
    if (HINT_SOURCE.test(source)) {
      const [kind, id] = source.slice("routing.hints.".length).split(":", 2);
      if (kind === "task" && id !== value.task) {
        fail(`${label}.sources.${name}`, "does not identify the workload Task");
      }
      if (
        kind === "plan" &&
        (value.parent_plan === null || value.parent_plan.id !== id)
      ) {
        fail(`${label}.sources.${name}`, "does not identify the workload parent plan");
      }
    }
  }

  const expectedRejections = [];
  if (value.role !== "implementer") expectedRejections.push("role_not_implementer");
  if (value.work_kind !== "implementation") {
    expectedRejections.push("work_not_bounded_implementation");
  }
  if (value.complexity !== "low") expectedRejections.push("complexity_not_low");
  if (value.risk !== "low") expectedRejections.push("risk_not_low");
  if (value.context_band === "large") expectedRejections.push("context_not_bounded");
  if (!HINT_SOURCE.test(value.sources.required_capabilities)) {
    expectedRejections.push("capabilities_not_explicit");
  }
  if (value.verification !== "objective") {
    expectedRejections.push("verification_not_objective");
  }
  if (
    value.retry.count > 0 ||
    value.history.changes_requested > 0 ||
    value.history.sessions_failed > 0 ||
    value.diagnostics.history_errors > 0
  ) {
    expectedRejections.push("unresolved_failure_history");
  }
  if (value.uncertainty_flags.some((flag) => flag !== "parent_plan_missing")) {
    expectedRejections.push("safety_evidence_uncertain");
  }
  if (
    JSON.stringify(value.lower_tier.rejection_reasons) !==
    JSON.stringify(expectedRejections)
  ) {
    fail(`${label}.lower_tier.rejection_reasons`, "does not match normalized evidence");
  }
}

function validateConsidered(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(label, "must be a non-empty array");
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    exactKeys(
      entry,
      ["candidate", "provider", "model", "tier", "eligible", "reasons"],
      entryLabel,
    );
    identifier(entry.candidate, `${entryLabel}.candidate`);
    identifier(entry.provider, `${entryLabel}.provider`);
    modelIdentifier(entry.model, `${entryLabel}.model`);
    identifier(entry.tier, `${entryLabel}.tier`);
    booleanValue(entry.eligible, `${entryLabel}.eligible`);
    if (!Array.isArray(entry.reasons)) {
      fail(`${entryLabel}.reasons`, "must be an array");
    }
    entry.reasons.forEach((reason, reasonIndex) => {
      if (!GATE_CODES.has(reason)) {
        fail(`${entryLabel}.reasons[${reasonIndex}]`, `has an unknown value: ${String(reason)}`);
      }
    });
    if (new Set(entry.reasons).size !== entry.reasons.length) {
      fail(`${entryLabel}.reasons`, "must not contain duplicates");
    }
    const reasonRanks = entry.reasons.map((reason) => SELECTION_REASON_CODES.indexOf(reason));
    if (reasonRanks.some((rank, reasonIndex) => reasonIndex > 0 && rank <= reasonRanks[reasonIndex - 1])) {
      fail(`${entryLabel}.reasons`, "must follow the fixed hard-gate order");
    }
    if (entry.eligible !== (entry.reasons.length === 0)) {
      fail(`${entryLabel}.eligible`, "must match an empty reasons list");
    }
    if (seen.has(entry.candidate)) {
      fail(label, `contains duplicate candidate ${entry.candidate}`);
    }
    seen.add(entry.candidate);
    if (index > 0 && compareText(value[index - 1].candidate, entry.candidate) >= 0) {
      fail(label, "must be ordered by candidate id");
    }
  });
}

function validateChosen(value, label) {
  exactKeys(value, ["candidate", "provider", "model", "tier"], label);
  identifier(value.candidate, `${label}.candidate`);
  identifier(value.provider, `${label}.provider`);
  modelIdentifier(value.model, `${label}.model`);
  identifier(value.tier, `${label}.tier`);
}

function validateFitness(value, label) {
  exactKeys(
    value,
    ["provider_distinct", "tier_surplus", "capability_surplus", "latency_rank", "cost_rank", "vector"],
    label,
  );
  if (value.provider_distinct !== 0 && value.provider_distinct !== 1) {
    fail(`${label}.provider_distinct`, "must be 0 or 1");
  }
  nonNegativeInteger(value.tier_surplus, `${label}.tier_surplus`);
  nonNegativeInteger(value.capability_surplus, `${label}.capability_surplus`);
  nonNegativeInteger(value.latency_rank, `${label}.latency_rank`);
  nonNegativeInteger(value.cost_rank, `${label}.cost_rank`);
  if (!Array.isArray(value.vector) || value.vector.length !== 5) {
    fail(`${label}.vector`, "must be the five-component fitness vector");
  }
  value.vector.forEach((entry, index) => finiteNumber(entry, `${label}.vector[${index}]`));
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function normalizedFraction(numerator, denominator) {
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  };
}

function decimalFraction(value) {
  const [coefficient, exponentText = "0"] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  let numerator = BigInt(`${whole}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return normalizedFraction(numerator, denominator);
}

function addFractions(left, right) {
  return normalizedFraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function expectedDeficit(observed, count, weight, totalWeight) {
  return normalizedFraction(
    BigInt(observed) * weight.numerator * totalWeight.denominator -
      BigInt(count) * totalWeight.numerator * weight.denominator,
    weight.denominator * totalWeight.numerator,
  );
}

function compareStoredFractions(left, right) {
  const difference =
    BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function validateDistribution(value, label) {
  exactKeys(
    value,
    ["window", "observed", "counts", "equivalent", "deficits", "applied", "changed_winner"],
    label,
  );
  positiveInteger(value.window, `${label}.window`);
  nonNegativeInteger(value.observed, `${label}.observed`);
  if (value.observed > value.window) {
    fail(`${label}.observed`, "cannot exceed the window");
  }
  if (!Array.isArray(value.counts)) {
    fail(`${label}.counts`, "must be a non-empty array");
  }
  if (value.counts.length === 0) fail(`${label}.counts`, "must be a non-empty array");
  const counts = new Map();
  value.counts.forEach((entry, index) => {
    const entryLabel = `${label}.counts[${index}]`;
    exactKeys(entry, ["provider", "weight", "count"], entryLabel);
    identifier(entry.provider, `${entryLabel}.provider`);
    finiteNumber(entry.weight, `${entryLabel}.weight`);
    if (entry.weight <= 0) fail(`${entryLabel}.weight`, "must be positive");
    nonNegativeInteger(entry.count, `${entryLabel}.count`);
    if (counts.has(entry.provider)) fail(`${label}.counts`, `duplicates provider ${entry.provider}`);
    if (index > 0 && compareText(value.counts[index - 1].provider, entry.provider) >= 0) {
      fail(`${label}.counts`, "must be ordered by provider id");
    }
    counts.set(entry.provider, entry);
  });
  const counted = [...counts.values()].reduce((sum, entry) => sum + entry.count, 0);
  if (counted !== value.observed) {
    fail(`${label}.counts`, "must sum to observed decisions");
  }
  if (!Array.isArray(value.equivalent) || value.equivalent.length === 0) {
    fail(`${label}.equivalent`, "must be a non-empty array");
  }
  value.equivalent.forEach((entry, index) => {
    identifier(entry, `${label}.equivalent[${index}]`);
    if (index > 0 && compareText(value.equivalent[index - 1], entry) >= 0) {
      fail(`${label}.equivalent`, "must contain unique ordered candidate ids");
    }
  });
  if (!Array.isArray(value.deficits)) {
    fail(`${label}.deficits`, "must be an array");
  }
  const totalWeight = [...counts.values()]
    .map(({ weight }) => decimalFraction(weight))
    .reduce(addFractions, { numerator: 0n, denominator: 1n });
  const deficitProviders = new Set();
  value.deficits.forEach((entry, index) => {
    const entryLabel = `${label}.deficits[${index}]`;
    exactKeys(entry, ["provider", "numerator", "denominator"], entryLabel);
    identifier(entry.provider, `${entryLabel}.provider`);
    if (typeof entry.numerator !== "string" || !/^-?[0-9]+$/.test(entry.numerator)) {
      fail(`${entryLabel}.numerator`, "must be an integer string");
    }
    if (typeof entry.denominator !== "string" || !/^[1-9][0-9]*$/.test(entry.denominator)) {
      fail(`${entryLabel}.denominator`, "must be a positive integer string");
    }
    if (deficitProviders.has(entry.provider)) {
      fail(`${label}.deficits`, `duplicates provider ${entry.provider}`);
    }
    if (index > 0 && compareText(value.deficits[index - 1].provider, entry.provider) >= 0) {
      fail(`${label}.deficits`, "must be ordered by provider id");
    }
    const count = counts.get(entry.provider);
    if (count === undefined) {
      fail(entryLabel, "references a provider absent from counts");
    }
    const expected = expectedDeficit(
      value.observed,
      count.count,
      decimalFraction(count.weight),
      totalWeight,
    );
    if (
      entry.numerator !== String(expected.numerator) ||
      entry.denominator !== String(expected.denominator)
    ) {
      fail(entryLabel, "does not match the exact weighted deficit");
    }
    deficitProviders.add(entry.provider);
  });
  booleanValue(value.applied, `${label}.applied`);
  booleanValue(value.changed_winner, `${label}.changed_winner`);
  if (value.applied !== (deficitProviders.size > 1)) {
    fail(`${label}.applied`, "must match multiple equivalent providers");
  }
}

function validateSameProviderReview(value, label) {
  if (value === null) {
    return;
  }
  exactKeys(value, ["implementer", "cross_provider_disqualified"], label);
  exactKeys(value.implementer, ["candidate", "provider"], `${label}.implementer`);
  identifier(value.implementer.candidate, `${label}.implementer.candidate`);
  identifier(value.implementer.provider, `${label}.implementer.provider`);
  if (!Array.isArray(value.cross_provider_disqualified)) {
    fail(`${label}.cross_provider_disqualified`, "must be an array");
  }
  value.cross_provider_disqualified.forEach((entry, index) => {
    const entryLabel = `${label}.cross_provider_disqualified[${index}]`;
    exactKeys(entry, ["candidate", "reasons"], entryLabel);
    identifier(entry.candidate, `${entryLabel}.candidate`);
    if (!Array.isArray(entry.reasons) || entry.reasons.length === 0) {
      fail(`${entryLabel}.reasons`, "must be a non-empty array");
    }
    entry.reasons.forEach((reason, reasonIndex) => {
      if (!GATE_CODES.has(reason)) {
        fail(`${entryLabel}.reasons[${reasonIndex}]`, `has an unknown value: ${String(reason)}`);
      }
    });
  });
}

// The complete operator-override audit row: who displaced the policy choice
// (cli or config, via which selector), what the normal policy winner was, the
// deterministic displaced rationale, which displaceable budget preferences
// were overridden, whether fallback is permitted, and explicit confirmation
// that every hard safety gate passed.
function validateOverride(value, label) {
  if (value === null) {
    return null;
  }
  exactKeys(
    value,
    [
      "candidate",
      "source",
      "selector",
      "allow_fallback",
      "policy_winner",
      "displaced_budgets",
      "displaced_rationale",
      "displaced_config_candidate",
      "hard_gates_passed",
    ],
    label,
  );
  identifier(value.candidate, `${label}.candidate`);
  enumValue(value.source, OVERRIDE_SOURCES, `${label}.source`);
  exactKeys(value.selector, ["task", "role"], `${label}.selector`);
  if (typeof value.selector.task !== "string" || !TASK_SELECTOR.test(value.selector.task)) {
    fail(`${label}.selector.task`, "must be an exact Task id or *");
  }
  enumValue(value.selector.role, ROUTED_ROLES, `${label}.selector.role`);
  booleanValue(value.allow_fallback, `${label}.allow_fallback`);
  validateChosen(value.policy_winner, `${label}.policy_winner`);
  if (!Array.isArray(value.displaced_budgets)) {
    fail(`${label}.displaced_budgets`, "must be an array");
  }
  value.displaced_budgets.forEach((entry, index) =>
    enumValue(entry, OVERRIDE_DISPLACEABLE, `${label}.displaced_budgets[${index}]`),
  );
  if (new Set(value.displaced_budgets).size !== value.displaced_budgets.length) {
    fail(`${label}.displaced_budgets`, "must not contain duplicates");
  }
  boundedLabel(value.displaced_rationale, `${label}.displaced_rationale`, DIAGNOSTIC_LIMIT);
  if (
    value.displaced_rationale !==
    overrideDisplacedRationale(value.candidate, value.policy_winner.candidate)
  ) {
    fail(`${label}.displaced_rationale`, "must be the deterministic displaced rationale");
  }
  if (value.displaced_config_candidate !== null) {
    identifier(value.displaced_config_candidate, `${label}.displaced_config_candidate`);
    if (value.source !== "cli") {
      fail(
        `${label}.displaced_config_candidate`,
        "is only recorded when a CLI override displaces a configured override",
      );
    }
  }
  if (value.hard_gates_passed !== true) {
    fail(`${label}.hard_gates_passed`, "must confirm every hard safety gate passed");
  }
  return {
    candidate: value.candidate,
    source: value.source,
    selector: { task: value.selector.task, role: value.selector.role },
    allow_fallback: value.allow_fallback,
    policy_winner: { ...value.policy_winner },
    displaced_budgets: [...value.displaced_budgets],
    displaced_rationale: value.displaced_rationale,
    displaced_config_candidate: value.displaced_config_candidate,
    hard_gates_passed: true,
  };
}

function validateEvents(value, label, recordedAt) {
  if (!Array.isArray(value)) {
    fail(label, "must be an array");
  }
  let previousAt = recordedAt;
  return value.map((event, index) => {
    const eventLabel = `${label}[${index}]`;
    exactKeys(
      event,
      ["sequence", "kind", "reason", "session_id", "observed_at"],
      eventLabel,
    );
    if (event.sequence !== index) {
      fail(`${eventLabel}.sequence`, "must be contiguous and zero-based");
    }
    enumValue(event.kind, EVENT_KINDS, `${eventLabel}.kind`);
    const reason = validateReason(event.reason, `${eventLabel}.reason`);
    if (EVENTS_WITHOUT_REASON.has(event.kind) !== (reason === null)) {
      fail(
        `${eventLabel}.reason`,
        EVENTS_WITHOUT_REASON.has(event.kind)
          ? "must be null for launch and completion"
          : "must classify this routing event",
      );
    }
    if (event.session_id !== null) {
      boundedLabel(event.session_id, `${eventLabel}.session_id`, SOURCE_LABEL_LIMIT);
    }
    const observedAt = timestamp(event.observed_at, `${eventLabel}.observed_at`);
    if (observedAt < previousAt) {
      fail(`${eventLabel}.observed_at`, "cannot move backward");
    }
    previousAt = observedAt;
    return {
      sequence: event.sequence,
      kind: event.kind,
      reason,
      session_id: event.session_id,
      observed_at: observedAt,
    };
  });
}

export function validateDecisionRecord(value, label = "Routing decision") {
  if (!isObject(value)) {
    fail(label, "must be an object");
  }
  const decisionFields = [
    "key",
    "step",
    "parent_step",
    "reason",
    "workload",
    "considered",
    "chosen",
    "fitness",
    "distribution",
    "same_provider_review",
    "override",
    "events",
    "status",
    "recorded_at",
    "observed_at",
  ];
  exactKeys(
    value,
    Object.hasOwn(value, "events")
      ? decisionFields
      : decisionFields.filter((field) => field !== "events"),
    label,
  );
  const key = validateDecisionKey(value.key);
  nonNegativeInteger(value.step, `${label}.step`);
  if (value.step === 0) {
    if (value.parent_step !== null) {
      fail(`${label}.parent_step`, "must be null for the initial step");
    }
    if (value.reason !== null) {
      fail(`${label}.reason`, "must be null for the initial step");
    }
  } else {
    if (value.parent_step !== value.step - 1) {
      fail(`${label}.parent_step`, "must reference the previous step");
    }
    if (value.reason === null) {
      fail(`${label}.reason`, "must explain a fallback or escalation step");
    }
  }
  const reason = validateReason(value.reason, `${label}.reason`);
  validateWorkloadSummary(value.workload, `${label}.workload`);
  if (value.workload.task !== key.task || value.workload.role !== key.role) {
    fail(`${label}.workload`, "must describe the decision key Task and Role");
  }
  validateConsidered(value.considered, `${label}.considered`);
  validateChosen(value.chosen, `${label}.chosen`);
  const override = validateOverride(value.override, `${label}.override`);
  if (override !== null) {
    if (override.candidate !== value.chosen.candidate) {
      fail(`${label}.override.candidate`, "must match the chosen candidate");
    }
    if (value.step !== 0) {
      fail(`${label}.override`, "must be attached to the initial selection step");
    }
    if (override.selector.task !== "*" && override.selector.task !== key.task) {
      fail(`${label}.override.selector.task`, "must select the decision key task");
    }
    if (override.selector.role !== key.role) {
      fail(`${label}.override.selector.role`, "must select the decision key role");
    }
  }
  const chosenEntry = value.considered.find(
    (entry) => entry.candidate === value.chosen.candidate,
  );
  if (chosenEntry === undefined) {
    fail(`${label}.chosen`, "must be an eligible considered candidate");
  }
  if (override === null) {
    if (chosenEntry.eligible !== true) {
      fail(`${label}.chosen`, "must be an eligible considered candidate");
    }
  } else if (
    JSON.stringify(chosenEntry.reasons) !== JSON.stringify(override.displaced_budgets)
  ) {
    fail(
      `${label}.override.displaced_budgets`,
      "must equal the chosen candidate's displaceable gate evidence",
    );
  }
  for (const field of ["provider", "model", "tier"]) {
    if (value.chosen[field] !== chosenEntry[field]) {
      fail(`${label}.chosen.${field}`, "must match the considered candidate");
    }
  }
  // With an override, the fitness/distribution invariants below govern the
  // recorded normal policy winner rather than the launched candidate.
  const policyChosen = override === null ? value.chosen : override.policy_winner;
  const policyLabel = override === null ? `${label}.chosen` : `${label}.override.policy_winner`;
  const policyEntry = value.considered.find(
    (entry) => entry.candidate === policyChosen.candidate,
  );
  if (policyEntry === undefined || policyEntry.eligible !== true) {
    fail(policyLabel, "must be an eligible considered candidate");
  }
  for (const field of ["provider", "model", "tier"]) {
    if (policyChosen[field] !== policyEntry[field]) {
      fail(`${policyLabel}.${field}`, "must match the considered candidate");
    }
  }
  validateFitness(value.fitness, `${label}.fitness`);
  const expectedVector = [
    value.fitness.provider_distinct,
    -value.fitness.tier_surplus,
    -value.fitness.capability_surplus,
    -value.fitness.latency_rank,
    -value.fitness.cost_rank,
  ];
  if (expectedVector.some((entry, index) => entry !== value.fitness.vector[index])) {
    fail(`${label}.fitness.vector`, "must match the named fitness components");
  }
  validateDistribution(value.distribution, `${label}.distribution`);
  const equivalentEntries = value.distribution.equivalent.map((candidate) =>
    value.considered.find((entry) => entry.candidate === candidate),
  );
  if (equivalentEntries.some((entry) => entry === undefined || entry.eligible !== true)) {
    fail(`${label}.distribution.equivalent`, "must contain only eligible considered candidates");
  }
  if (!value.distribution.equivalent.includes(policyChosen.candidate)) {
    fail(
      `${label}.distribution.equivalent`,
      override === null
        ? "must include the chosen candidate"
        : "must include the normal policy winner",
    );
  }
  const equivalentProviders = [...new Set(equivalentEntries.map(({ provider }) => provider))].sort(
    compareText,
  );
  const consideredProviders = [...new Set(value.considered.map(({ provider }) => provider))].sort(
    compareText,
  );
  const countedProviders = value.distribution.counts.map(({ provider }) => provider);
  if (JSON.stringify(consideredProviders) !== JSON.stringify(countedProviders)) {
    fail(`${label}.distribution.counts`, "must cover every considered provider exactly once");
  }
  const deficitProviders = value.distribution.deficits.map(({ provider }) => provider);
  if (JSON.stringify(equivalentProviders) !== JSON.stringify(deficitProviders)) {
    fail(`${label}.distribution.deficits`, "must match the equivalent candidate providers");
  }
  let greatestDeficit = value.distribution.deficits[0];
  for (const deficit of value.distribution.deficits.slice(1)) {
    if (compareStoredFractions(deficit, greatestDeficit) > 0) {
      greatestDeficit = deficit;
    }
  }
  const expectedWinner = equivalentEntries.find(
    ({ provider }) => provider === greatestDeficit.provider,
  );
  if (policyChosen.candidate !== expectedWinner.candidate) {
    fail(
      override === null ? `${label}.chosen.candidate` : `${label}.override.policy_winner`,
      "must be the stable candidate-id winner for the greatest provider deficit",
    );
  }
  const expectedChanged = policyChosen.candidate !== value.distribution.equivalent[0];
  if (value.distribution.changed_winner !== expectedChanged) {
    fail(`${label}.distribution.changed_winner`, "must identify a change from the fitness winner");
  }
  validateSameProviderReview(value.same_provider_review, `${label}.same_provider_review`);
  if (value.same_provider_review !== null) {
    if (value.chosen.provider !== value.same_provider_review.implementer.provider) {
      fail(`${label}.same_provider_review`, "requires a same-provider chosen candidate");
    }
    const expectedDisqualified = value.considered
      .filter(
        (entry) =>
          entry.provider !== value.same_provider_review.implementer.provider &&
          entry.reasons.length > 0,
      )
      .map((entry) => ({ candidate: entry.candidate, reasons: entry.reasons }));
    if (
      JSON.stringify(value.same_provider_review.cross_provider_disqualified) !==
      JSON.stringify(expectedDisqualified)
    ) {
      fail(
        `${label}.same_provider_review.cross_provider_disqualified`,
        "must match every cross-provider considered candidate and reason",
      );
    }
  }
  const recordedAt = timestamp(value.recorded_at, `${label}.recorded_at`);
  const events = validateEvents(value.events ?? [], `${label}.events`, recordedAt);
  if (!Object.hasOwn(STATUS_RANK, value.status)) {
    fail(`${label}.status`, `has an unknown value: ${String(value.status)}`);
  }
  const observedAt = timestamp(value.observed_at, `${label}.observed_at`);
  if (observedAt < recordedAt) {
    fail(`${label}.observed_at`, "cannot be before recorded_at");
  }
  if (events.length > 0 && events[events.length - 1].observed_at !== observedAt) {
    fail(`${label}.observed_at`, "must match the latest routing event");
  }
  return {
    key,
    step: value.step,
    parent_step: value.parent_step,
    reason,
    workload: structuredClone(value.workload),
    considered: structuredClone(value.considered),
    chosen: structuredClone(value.chosen),
    fitness: structuredClone(value.fitness),
    distribution: structuredClone(value.distribution),
    same_provider_review: structuredClone(value.same_provider_review),
    override,
    events,
    status: value.status,
    recorded_at: recordedAt,
    observed_at: observedAt,
  };
}

export function decisionRecordFromSelection(
  selection,
  { status = "selected", recorded_at, observed_at, reason = null, override = selection.override ?? null },
) {
  if (status !== "selected") {
    fail("Routing decision.status", "must be selected before dispatch");
  }
  let normalizedReason = null;
  if (reason !== null) {
    exactKeys(reason, ["code", "diagnostic"], "Routing decision.reason");
    if (typeof reason.diagnostic !== "string") {
      fail("Routing decision.reason.diagnostic", "must be a string");
    }
    normalizedReason = normalizeFailureReason(reason.code, reason.diagnostic);
  }
  return validateDecisionRecord({
    key: structuredClone(selection.key),
    step: selection.step,
    parent_step: selection.parent_step,
    reason: normalizedReason,
    workload: structuredClone(selection.workload),
    considered: structuredClone(selection.considered),
    chosen: structuredClone(selection.chosen),
    fitness: structuredClone(selection.fitness),
    distribution: structuredClone(selection.distribution),
    same_provider_review: structuredClone(selection.same_provider_review),
    override: structuredClone(override),
    events: [],
    status,
    recorded_at,
    observed_at: observed_at ?? recorded_at,
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateLedger(value) {
  exactKeys(value, ["schema", "updated_at", "decisions"], "Routing decision ledger");
  if (value.schema !== ROUTING_DECISIONS_SCHEMA) {
    fail("Routing decision ledger.schema", `must be ${ROUTING_DECISIONS_SCHEMA}`);
  }
  const updatedAt =
    value.updated_at === null
      ? null
      : timestamp(value.updated_at, "Routing decision ledger.updated_at");
  if (!Array.isArray(value.decisions)) {
    fail("Routing decision ledger.decisions", "must be an array");
  }
  const decisions = value.decisions.map((entry, index) =>
    validateDecisionRecord(entry, `Routing decision ${index}`),
  );
  const stepsByKey = new Map();
  decisions.forEach((record, index) => {
    const keyString = decisionKeyString(record.key);
    const partialKey = `${record.key.task}:${record.key.role}:${record.key.attempt}`;
    const existing = stepsByKey.get(partialKey);
    if (index > 0 && record.recorded_at < decisions[index - 1].recorded_at) {
      fail(`Routing decision ${index}.recorded_at`, "must preserve append chronology");
    }
    const windowRows = decisions.slice(
      Math.max(0, index - record.distribution.window),
      index,
    );
    if (record.distribution.observed !== windowRows.length) {
      fail(
        `Routing decision ${index}.distribution.observed`,
        "must equal the actual preceding ledger window",
      );
    }
    for (const count of record.distribution.counts) {
      const expectedCount = windowRows.filter(
        (entry) => entry.chosen.provider === count.provider,
      ).length;
      if (count.count !== expectedCount) {
        fail(
          `Routing decision ${index}.distribution.counts.${count.provider}`,
          "does not match preceding ledger decisions",
        );
      }
    }
    if (existing === undefined) {
      stepsByKey.set(partialKey, {
        policy_revision: record.key.policy_revision,
        steps: [record.step],
      });
    } else {
      if (existing.policy_revision !== record.key.policy_revision) {
        fail(
          `Routing decision ${index}`,
          `conflicts with another policy revision for ${partialKey}`,
        );
      }
      if (existing.steps.includes(record.step)) {
        fail(`Routing decision ${index}`, `duplicates ${keyString} step ${record.step}`);
      }
      existing.steps.push(record.step);
    }
  });
  for (const [partialKey, entry] of stepsByKey) {
    const sorted = [...entry.steps].sort((a, b) => a - b);
    sorted.forEach((step, index) => {
      if (step !== index) {
        fail("Routing decision ledger", `has non-contiguous steps for ${partialKey}`);
      }
    });
  }
  const latestObserved = decisions.reduce(
    (latest, record) =>
      latest === null || record.observed_at > latest ? record.observed_at : latest,
    null,
  );
  if (updatedAt !== latestObserved) {
    fail(
      "Routing decision ledger.updated_at",
      "must equal the latest decision observed_at timestamp",
    );
  }
  return { schema: ROUTING_DECISIONS_SCHEMA, updated_at: updatedAt, decisions };
}

function validateSnapshot(snapshot) {
  exactKeys(snapshot, ["schema", "updated_at", "decisions", "raw"], "Routing ledger snapshot");
  const projected = validateLedger({
    schema: snapshot.schema,
    updated_at: snapshot.updated_at,
    decisions: snapshot.decisions,
  });
  let persisted;
  if (snapshot.raw === null) {
    persisted = { schema: ROUTING_DECISIONS_SCHEMA, updated_at: null, decisions: [] };
  } else {
    if (typeof snapshot.raw !== "string") {
      fail("Routing ledger snapshot.raw", "must be a string or null");
    }
    let parsed;
    try {
      parsed = JSON.parse(snapshot.raw);
    } catch (error) {
      throw new RoutingLedgerError(
        `Routing ledger snapshot.raw must be valid JSON: ${error.message}`,
        { cause: error },
      );
    }
    persisted = validateLedger(parsed);
  }
  if (stableStringify(projected) !== stableStringify(persisted)) {
    fail("Routing ledger snapshot", "fields do not correspond to snapshot.raw");
  }
  return snapshot;
}

function findRecordIndex(decisions, key, step) {
  return decisions.findIndex(
    (record) =>
      record.key.task === key.task &&
      record.key.role === key.role &&
      record.key.attempt === key.attempt &&
      record.key.policy_revision === key.policy_revision &&
      record.step === step,
  );
}

export class RoutingDecisionLedger {
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

  // A missing ledger is an empty state. Malformed or conflicting content is a
  // named error; nothing in this class ever overwrites it automatically.
  async load() {
    const raw = await this.#currentRaw();
    if (raw === null) {
      return deepFreeze({
        schema: ROUTING_DECISIONS_SCHEMA,
        updated_at: null,
        decisions: [],
        raw: null,
      });
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new RoutingLedgerError(
        `Routing decision ledger must be valid JSON: ${error.message}`,
        { cause: error },
      );
    }
    return deepFreeze({ ...validateLedger(value), raw });
  }

  async #commit(snapshot, ledger) {
    validateSnapshot(snapshot);
    const normalized = validateLedger(ledger);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new RoutingLedgerConflictError();
      }
      throw error;
    }
    try {
      const current = await this.#currentRaw();
      if (current !== snapshot.raw) {
        throw new RoutingLedgerConflictError();
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

  // Compare-and-swap persistence of one immutable decision step. Recording an
  // identical record twice is an idempotent no-op; a mismatched immutable
  // field or policy revision fails closed without touching recorded history.
  async record(snapshot, value) {
    validateSnapshot(snapshot);
    const record = validateDecisionRecord(value);
    if (record.status !== "selected") {
      throw new RoutingLedgerError("An initial routing decision must be recorded as selected");
    }
    const existingIndex = findRecordIndex(snapshot.decisions, record.key, record.step);
    if (existingIndex !== -1) {
      const existing = snapshot.decisions[existingIndex];
      if (stableStringify(existing) === stableStringify(record)) {
        return snapshot;
      }
      throw new RoutingLedgerError(
        `Refusing to rewrite recorded decision ${decisionKeyString(record.key)} step ${record.step}`,
      );
    }
    const keyRows = snapshot.decisions.filter(
      (entry) =>
        entry.key.task === record.key.task &&
        entry.key.role === record.key.role &&
        entry.key.attempt === record.key.attempt,
    );
    if (keyRows.some((entry) => entry.key.policy_revision !== record.key.policy_revision)) {
      throw new RoutingLedgerError(
        `Policy revision mismatch for ${record.key.task}:${record.key.role}:${record.key.attempt}`,
      );
    }
    if (record.step !== keyRows.length) {
      throw new RoutingLedgerError(
        `Decision ${decisionKeyString(record.key)} step ${record.step} is not the next step`,
      );
    }
    if (snapshot.updated_at !== null && record.recorded_at < snapshot.updated_at) {
      throw new RoutingLedgerError(
        `Decision ${decisionKeyString(record.key)} is older than the ledger snapshot`,
      );
    }
    const updatedAt =
      snapshot.updated_at === null || record.observed_at > snapshot.updated_at
        ? record.observed_at
        : snapshot.updated_at;
    return this.#commit(snapshot, {
      schema: ROUTING_DECISIONS_SCHEMA,
      updated_at: updatedAt,
      decisions: [...snapshot.decisions, record],
    });
  }

  async appendEvent(
    snapshot,
    { key, step, kind, reason = null, session_id = null, observed_at },
  ) {
    validateSnapshot(snapshot);
    const validatedKey = validateDecisionKey(key);
    nonNegativeInteger(step, "event.step");
    enumValue(kind, EVENT_KINDS, "event.kind");
    const normalizedReason =
      reason === null
        ? null
        : normalizeFailureReason(reason.code, reason.diagnostic ?? "");
    if (EVENTS_WITHOUT_REASON.has(kind) !== (normalizedReason === null)) {
      fail(
        "event.reason",
        EVENTS_WITHOUT_REASON.has(kind)
          ? "must be null for launch and completion"
          : "must classify this routing event",
      );
    }
    if (session_id !== null) {
      boundedLabel(session_id, "event.session_id", SOURCE_LABEL_LIMIT);
    }
    const observedAt = timestamp(observed_at, "event.observed_at");
    const index = findRecordIndex(snapshot.decisions, validatedKey, step);
    if (index === -1) {
      throw new RoutingLedgerError(
        `Unknown decision ${decisionKeyString(validatedKey)} step ${step}`,
      );
    }
    const current = snapshot.decisions[index];
    if (observedAt < current.observed_at) {
      throw new RoutingLedgerError("Routing event observed_at cannot move backward");
    }
    let status = current.status;
    if (kind === "launch") {
      if (!new Set(["selected", "dispatched"]).has(current.status)) {
        throw new RoutingLedgerError(`Cannot launch a ${current.status} routing step`);
      }
      status = "dispatched";
    } else if (kind === "failure") {
      if (current.status !== "dispatched") {
        throw new RoutingLedgerError(`Cannot fail a ${current.status} routing step`);
      }
      status = "failed";
    } else if (kind === "completion") {
      if (current.status !== "dispatched") {
        throw new RoutingLedgerError(`Cannot complete a ${current.status} routing step`);
      }
      status = "completed";
    } else if (kind === "capacity_pause") {
      if (current.status !== "dispatched") {
        throw new RoutingLedgerError(`Cannot pause a ${current.status} routing step`);
      }
    } else if (!new Set(["failed", "superseded"]).has(current.status)) {
      throw new RoutingLedgerError(
        `Cannot append ${kind} to a ${current.status} routing step`,
      );
    }
    const event = {
      sequence: current.events.length,
      kind,
      reason: normalizedReason,
      session_id,
      observed_at: observedAt,
    };
    const decisions = snapshot.decisions.map((record, position) =>
      position === index
        ? {
            ...record,
            status,
            events: [...record.events, event],
            observed_at: observedAt,
          }
        : record,
    );
    const updatedAt =
      snapshot.updated_at === null || observedAt > snapshot.updated_at
        ? observedAt
        : snapshot.updated_at;
    return this.#commit(snapshot, {
      schema: ROUTING_DECISIONS_SCHEMA,
      updated_at: updatedAt,
      decisions,
    });
  }

  async updateOutcome(snapshot, { key, step, status, observed_at }) {
    validateSnapshot(snapshot);
    const validatedKey = validateDecisionKey(key);
    nonNegativeInteger(step, "outcome.step");
    if (!Object.hasOwn(STATUS_RANK, status)) {
      fail("outcome.status", `has an unknown value: ${String(status)}`);
    }
    const observedAt = timestamp(observed_at, "outcome.observed_at");
    const index = findRecordIndex(snapshot.decisions, validatedKey, step);
    if (index === -1) {
      throw new RoutingLedgerError(
        `Unknown decision ${decisionKeyString(validatedKey)} step ${step}`,
      );
    }
    const current = snapshot.decisions[index];
    const allowedNext =
      current.status === "selected"
        ? new Set(["dispatched"])
        : current.status === "dispatched"
        ? new Set(["completed", "failed", "superseded"])
        : new Set();
    if (!allowedNext.has(status)) {
      throw new RoutingLedgerError(
        `Decision status cannot move from ${current.status} to ${status}`,
      );
    }
    if (observedAt < current.observed_at) {
      throw new RoutingLedgerError("Decision observed_at cannot move backward");
    }
    const decisions = snapshot.decisions.map((record, position) =>
      position === index ? { ...record, status, observed_at: observedAt } : record,
    );
    const updatedAt =
      snapshot.updated_at === null || observedAt > snapshot.updated_at
        ? observedAt
        : snapshot.updated_at;
    return this.#commit(snapshot, {
      schema: ROUTING_DECISIONS_SCHEMA,
      updated_at: updatedAt,
      decisions,
    });
  }

  async attachOverride(snapshot, { key, step, override, observed_at }) {
    validateSnapshot(snapshot);
    const validatedKey = validateDecisionKey(key);
    nonNegativeInteger(step, "override.step");
    const validatedOverride = validateOverride(override, "override");
    if (validatedOverride === null) {
      fail("override", "must contain candidate and source");
    }
    const observedAt = timestamp(observed_at, "override.observed_at");
    const index = findRecordIndex(snapshot.decisions, validatedKey, step);
    if (index === -1) {
      throw new RoutingLedgerError(
        `Unknown decision ${decisionKeyString(validatedKey)} step ${step}`,
      );
    }
    if (snapshot.decisions[index].override !== null) {
      throw new RoutingLedgerError(
        `Decision ${decisionKeyString(validatedKey)} step ${step} already has an override`,
      );
    }
    if (snapshot.decisions[index].status !== "selected") {
      throw new RoutingLedgerError("An override must be attached before dispatch");
    }
    if (observedAt < snapshot.decisions[index].observed_at) {
      throw new RoutingLedgerError("Decision observed_at cannot move backward");
    }
    const decisions = snapshot.decisions.map((record, position) =>
      position === index
        ? { ...record, override: validatedOverride, observed_at: observedAt }
        : record,
    );
    const updatedAt =
      snapshot.updated_at === null || observedAt > snapshot.updated_at
        ? observedAt
        : snapshot.updated_at;
    return this.#commit(snapshot, {
      schema: ROUTING_DECISIONS_SCHEMA,
      updated_at: updatedAt,
      decisions,
    });
  }

  // Exact-key resolution. The recorded active candidate is returned for the
  // same policy revision even when newer ledger rows changed distribution; a
  // different revision for the same Task/Role action fails closed.
  async resolveKey(key) {
    const validatedKey = validateDecisionKey(key);
    const state = await this.load();
    const rows = state.decisions.filter(
      (record) =>
        record.key.task === validatedKey.task &&
        record.key.role === validatedKey.role &&
        record.key.attempt === validatedKey.attempt,
    );
    if (rows.length === 0) {
      return null;
    }
    if (rows.some((record) => record.key.policy_revision !== validatedKey.policy_revision)) {
      throw new RoutingLedgerError(
        `Recorded decision for ${validatedKey.task}:${validatedKey.role}:${validatedKey.attempt} uses another policy revision`,
      );
    }
    const steps = [...rows].sort((left, right) => left.step - right.step);
    return deepFreeze({
      key_string: decisionKeyString(validatedKey),
      steps,
      active: steps[steps.length - 1],
    });
  }

  async latestDecision(task, role) {
    nonEmptyString(task, "task");
    identifier(role, "role");
    const state = await this.load();
    for (let index = state.decisions.length - 1; index >= 0; index -= 1) {
      const record = state.decisions[index];
      if (record.key.task === task && record.key.role === role) {
        return record;
      }
    }
    return null;
  }

  async windowCounts(window) {
    positiveInteger(window, "window");
    const state = await this.load();
    const rows = state.decisions.slice(-window);
    const counts = new Map();
    for (const record of rows) {
      counts.set(record.chosen.provider, (counts.get(record.chosen.provider) ?? 0) + 1);
    }
    return deepFreeze({
      window,
      observed: rows.length,
      counts: [...counts.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([provider, count]) => ({ provider, count })),
    });
  }

  // The complete sanitized read model for the dashboard. Every field comes
  // from validated ledger records (which never contain argv, executable
  // paths, environment, credentials, prompt bodies, continuation tokens, or
  // unsanitized provider stderr) plus display-only derivations: how a step
  // was reached, whether its route exhausted, the sanitized session ids it
  // touched, the compared Implementer decision for a Reviewer row, and
  // window share arithmetic so rendering code never reproduces selection
  // math.
  async dashboardProjection() {
    const state = await this.load();
    const decisions = state.decisions.map((record) => ({
      key_string: decisionKeyString(record.key),
      task: record.key.task,
      role: record.key.role,
      attempt: record.key.attempt,
      policy_revision: record.key.policy_revision,
      step: record.step,
      parent_step: record.parent_step,
      status: record.status,
      reason:
        record.reason === null
          ? null
          : { code: record.reason.code, diagnostic: record.reason.diagnostic },
      advanced_by:
        record.step === 0
          ? null
          : record.reason !== null && ESCALATION_ADVANCE_CODES.has(record.reason.code)
          ? "escalation"
          : "fallback",
      exhausted: record.events.some((event) => event.kind === "exhausted"),
      session_ids: [
        ...new Set(
          record.events
            .map((event) => event.session_id)
            .filter((sessionId) => sessionId !== null),
        ),
      ],
      workload: structuredClone(record.workload),
      considered: structuredClone(record.considered),
      chosen: { ...record.chosen },
      fitness: structuredClone(record.fitness),
      distribution: structuredClone(record.distribution),
      override: structuredClone(record.override),
      same_provider_review: structuredClone(record.same_provider_review),
      reviewer_comparison: reviewerComparison(state.decisions, record),
      events: record.events.map((event) => ({
        sequence: event.sequence,
        kind: event.kind,
        reason:
          event.reason === null
            ? null
            : { code: event.reason.code, diagnostic: event.reason.diagnostic },
        session_id: event.session_id,
        observed_at: event.observed_at,
      })),
      recorded_at: record.recorded_at,
      observed_at: record.observed_at,
    }));
    return deepFreeze({
      schema: ROUTING_DECISIONS_SCHEMA,
      updated_at: state.updated_at,
      decisions,
      summary: projectionSummary(state.decisions),
    });
  }
}

// The recorded Implementer decision a Reviewer row was compared against:
// the latest Implementer step for the same Task attempt, exactly how the
// dispatch adapter resolved it at selection time.
function reviewerComparison(decisions, record) {
  if (record.key.role !== "reviewer") {
    return null;
  }
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const candidate = decisions[index];
    if (
      candidate.key.task === record.key.task &&
      candidate.key.role === "implementer" &&
      candidate.key.attempt === record.key.attempt
    ) {
      return {
        candidate: candidate.chosen.candidate,
        provider: candidate.chosen.provider,
        model: candidate.chosen.model,
        tier: candidate.chosen.tier,
        provider_distinct: candidate.chosen.provider !== record.chosen.provider,
      };
    }
  }
  return null;
}

// Display arithmetic over the configured finite window that ends at the
// latest decision: configured target shares, actual shares, and the signed
// deficit (positive = under target) in decision counts. The exact rational
// deficits each selection actually used remain on the per-decision
// distribution evidence; these numbers exist only for the summary view.
function projectionSummary(decisions) {
  if (decisions.length === 0) {
    return null;
  }
  const latest = decisions[decisions.length - 1];
  const window = latest.distribution.window;
  const rows = decisions.slice(-window);
  const observed = rows.length;
  const weights = new Map(
    latest.distribution.counts.map(({ provider, weight }) => [provider, weight]),
  );
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const tally = (select) => {
    const counts = new Map();
    for (const row of rows) {
      const value = select(row);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };
  const providerCounts = tally((row) => row.chosen.provider);
  const providers = [...new Set([...weights.keys(), ...providerCounts.keys()])]
    .sort(compareText)
    .map((provider) => {
      const weight = weights.get(provider) ?? null;
      const count = providerCounts.get(provider) ?? 0;
      const targetShare = weight === null || totalWeight === 0 ? null : weight / totalWeight;
      return {
        provider,
        weight,
        target_share: targetShare,
        count,
        actual_share: observed === 0 ? 0 : count / observed,
        deficit: targetShare === null ? null : targetShare * observed - count,
      };
    });
  const grouped = (counts, name) =>
    [...counts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([value, count]) => ({ [name]: value, count }));
  return {
    window,
    observed,
    providers,
    models: grouped(tally((row) => row.chosen.model), "model"),
    tiers: grouped(tally((row) => row.chosen.tier), "tier"),
    roles: grouped(tally((row) => row.key.role), "role"),
  };
}
