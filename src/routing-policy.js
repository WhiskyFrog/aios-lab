import { validateRoutingConfig } from "./routing.js";

// Pure candidate selection. This module performs no file I/O, Worker launch,
// clock read, random draw, or model call: every input arrives validated and
// every output is a deterministic function of those inputs.

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_ID = /^task-[0-9]{4,}$/;
const ROUTED_ROLES = new Set(["implementer", "reviewer"]);
const WORK_KINDS = new Set(["planning", "implementation", "unknown"]);
const BANDS = new Set(["low", "medium", "high", "unknown"]);
const CONTEXT_BANDS = new Set(["small", "medium", "large"]);
const VERIFICATION = new Set(["objective", "subjective", "unknown"]);
const APPROVALS = new Set(["not_required", "required", "approved", "rejected"]);
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
const ROUTING_HINT_SOURCE = /^routing\.hints\.(?:task:task-[0-9]{4,}|plan:[a-z0-9][a-z0-9._-]*)$/;
const ESCALATION_REASON_CODES = new Set([
  "test_failure",
  "review_rejected",
  "duplicate_evidence",
  "context_failure",
]);

// Hard-gate reason codes in the fixed order they are evaluated. Cost and
// distribution operate strictly after these gates and can never restore a
// candidate any of them removed.
export const SELECTION_REASON_CODES = Object.freeze([
  "candidate_disabled",
  "role_ineligible",
  "prior_step_candidate",
  "capability_missing",
  "context_capacity_insufficient",
  "cost_budget_exceeded",
  "latency_budget_exceeded",
  "tier_below_minimum",
  "tier_below_reviewer_floor",
]);

export class RoutingPolicyError extends TypeError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "RoutingPolicyError";
  }
}

export class NoEligibleCandidateError extends RoutingPolicyError {
  constructor(message, considered) {
    super(message);
    this.name = "NoEligibleCandidateError";
    this.considered = considered;
  }
}

function fail(label, message) {
  throw new RoutingPolicyError(`${label}: ${message}`);
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceLabelAllowed(name, value) {
  if (ROUTING_HINT_SOURCE.test(value)) {
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

function matchingHint(config, source, key, workload) {
  if (!ROUTING_HINT_SOURCE.test(source)) {
    return null;
  }
  const [kind, id] = source.slice("routing.hints.".length).split(":", 2);
  if (kind === "task" && id !== key.task) {
    fail("workload.sources", `hint source ${source} does not identify ${key.task}`);
  }
  if (
    kind === "plan" &&
    (workload.parent_plan === null || workload.parent_plan.id !== id)
  ) {
    fail("workload.sources", `hint source ${source} does not identify the parent plan`);
  }
  const hint = config.hints.find(
    (entry) => entry.selector[kind] === id,
  );
  if (hint === undefined) {
    fail("workload.sources", `hint source ${source} is absent from routing config`);
  }
  return hint;
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

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) {
    fail(label, `has an unknown value: ${String(value)}`);
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

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(label, `must be a lowercase identifier, got ${String(value)}`);
  }
  return value;
}

export function validateDecisionKey(key) {
  if (!isObject(key)) {
    fail("decision key", "must be an object");
  }
  const allowed = ["task", "role", "attempt", "policy_revision"];
  for (const name of allowed) {
    if (!Object.hasOwn(key, name)) {
      fail("decision key", `is missing required field ${name}`);
    }
  }
  for (const name of Object.keys(key)) {
    if (!allowed.includes(name)) {
      fail(`decision key.${name}`, "is not allowed");
    }
  }
  if (typeof key.task !== "string" || !TASK_ID.test(key.task)) {
    fail("decision key.task", `must be a Task id, got ${String(key.task)}`);
  }
  enumValue(key.role, ROUTED_ROLES, "decision key.role");
  positiveInteger(key.attempt, "decision key.attempt");
  identifier(key.policy_revision, "decision key.policy_revision");
  return deepFreeze({
    task: key.task,
    role: key.role,
    attempt: key.attempt,
    policy_revision: key.policy_revision,
  });
}

export function decisionKeyString(key) {
  const validated = validateDecisionKey(key);
  return `${validated.task}:${validated.role}:${validated.attempt}:${validated.policy_revision}`;
}

function sameKey(left, right) {
  return (
    left.task === right.task &&
    left.role === right.role &&
    left.attempt === right.attempt &&
    left.policy_revision === right.policy_revision
  );
}

function validateWorkload(workload, key, config) {
  exactKeys(
    workload,
    [
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
      "uncertainty_flags",
      "minimum_tier",
      "lower_tier",
      "sources",
      "diagnostics",
    ],
    "workload",
  );
  const tiers = new Set(config.tiers.map(({ id }) => id));
  const costClasses = new Set(config.cost_classes);
  const latencyClasses = new Set(config.latency_classes);
  const capabilities = new Set(config.capabilities);

  if (workload.task_id !== key.task) {
    fail("workload.task_id", `does not match decision key task ${key.task}`);
  }
  if (workload.role !== key.role) {
    fail("workload.role", `does not match decision key role ${key.role}`);
  }
  enumValue(workload.work_kind, WORK_KINDS, "workload.work_kind");
  enumValue(workload.complexity, BANDS, "workload.complexity");
  enumValue(workload.risk, BANDS, "workload.risk");
  enumValue(workload.verification_burden, VERIFICATION, "workload.verification_burden");
  enumValue(workload.approval, APPROVALS, "workload.approval");
  exactKeys(workload.context_size, ["bytes", "estimated_tokens", "band"], "workload.context_size");
  positiveInteger(workload.context_size.bytes, "workload.context_size.bytes");
  positiveInteger(workload.context_size.estimated_tokens, "workload.context_size.estimated_tokens");
  enumValue(workload.context_size.band, CONTEXT_BANDS, "workload.context_size.band");
  const expectedTokens = Math.ceil(workload.context_size.bytes / 4);
  const expectedBand =
    workload.context_size.bytes <= 8_000
      ? "small"
      : workload.context_size.bytes <= 32_000
      ? "medium"
      : "large";
  if (
    workload.context_size.estimated_tokens !== expectedTokens ||
    workload.context_size.band !== expectedBand
  ) {
    fail("workload.context_size", "does not match the normalized byte thresholds");
  }
  if (!tiers.has(workload.minimum_tier)) {
    fail("workload.minimum_tier", `references unknown tier ${String(workload.minimum_tier)}`);
  }
  exactKeys(workload.budgets, ["cost", "latency"], "workload.budgets");
  if (!costClasses.has(workload.budgets.cost)) {
    fail("workload.budgets.cost", `references unknown cost class ${String(workload.budgets.cost)}`);
  }
  if (!latencyClasses.has(workload.budgets.latency)) {
    fail(
      "workload.budgets.latency",
      `references unknown latency class ${String(workload.budgets.latency)}`,
    );
  }
  if (!Array.isArray(workload.required_capabilities)) {
    fail("workload.required_capabilities", "must be an array");
  }
  if (new Set(workload.required_capabilities).size !== workload.required_capabilities.length) {
    fail("workload.required_capabilities", "contains duplicates");
  }
  for (const capability of workload.required_capabilities) {
    if (!capabilities.has(capability)) {
      fail(
        "workload.required_capabilities",
        `references unknown capability ${String(capability)}`,
      );
    }
  }
  exactKeys(workload.lower_tier, ["eligible", "rejection_reasons"], "workload.lower_tier");
  if (typeof workload.lower_tier.eligible !== "boolean") {
    fail("workload.lower_tier.eligible", "must be a boolean");
  }
  if (!Array.isArray(workload.lower_tier.rejection_reasons)) {
    fail("workload.lower_tier.rejection_reasons", "must be an array");
  }
  for (const [index, reason] of workload.lower_tier.rejection_reasons.entries()) {
    if (!LOWER_TIER_REASONS.has(reason)) {
      fail(`workload.lower_tier.rejection_reasons[${index}]`, "has an unknown value");
    }
  }
  if (
    new Set(workload.lower_tier.rejection_reasons).size !==
    workload.lower_tier.rejection_reasons.length
  ) {
    fail("workload.lower_tier.rejection_reasons", "contains duplicates");
  }
  if (!Array.isArray(workload.uncertainty_flags)) {
    fail("workload.uncertainty_flags", "must be an array");
  }
  for (const [index, flag] of workload.uncertainty_flags.entries()) {
    identifier(flag, `workload.uncertainty_flags[${index}]`);
  }
  if (new Set(workload.uncertainty_flags).size !== workload.uncertainty_flags.length) {
    fail("workload.uncertainty_flags", "contains duplicates");
  }
  exactKeys(workload.retry, ["count", "limit"], "workload.retry");
  nonNegativeInteger(workload.retry.count, "workload.retry.count");
  nonNegativeInteger(workload.retry.limit, "workload.retry.limit");
  if (workload.retry.count > workload.retry.limit) {
    fail("workload.retry", "count cannot exceed limit");
  }
  exactKeys(
    workload.history,
    ["reviews_total", "changes_requested", "sessions_failed", "capacity_deferred"],
    "workload.history",
  );
  for (const [name, count] of Object.entries(workload.history)) {
    nonNegativeInteger(count, `workload.history.${name}`);
  }
  exactKeys(workload.sources, WORKLOAD_SOURCE_KEYS, "workload.sources");
  for (const [name, source] of Object.entries(workload.sources)) {
    if (typeof source !== "string" || source.length === 0 || source.length > 120) {
      fail(`workload.sources.${name}`, "must be a bounded non-empty source label");
    }
    if (!sourceLabelAllowed(name, source)) {
      fail(`workload.sources.${name}`, "is not a recognized normalized source label");
    }
    const hint = matchingHint(config, source, key, workload);
    if (hint !== null) {
      const actual =
        name === "verification_burden"
          ? workload.verification_burden
          : name === "budgets"
          ? workload.budgets
          : workload[name];
      const expected =
        name === "verification_burden"
          ? hint.verification
          : name === "budgets"
          ? { cost: hint.cost_budget, latency: hint.latency_budget }
          : hint[name];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`workload.${name}`, `does not match ${source}`);
      }
    }
  }
  exactKeys(
    workload.diagnostics,
    ["strict_planning_contract", "plan_errors", "history_errors"],
    "workload.diagnostics",
  );
  if (typeof workload.diagnostics.strict_planning_contract !== "boolean") {
    fail("workload.diagnostics.strict_planning_contract", "must be a boolean");
  }
  for (const name of ["plan_errors", "history_errors"]) {
    if (!Array.isArray(workload.diagnostics[name])) {
      fail(`workload.diagnostics.${name}`, "must be an array");
    }
    for (const [index, message] of workload.diagnostics[name].entries()) {
      if (typeof message !== "string" || message.length === 0) {
        fail(`workload.diagnostics.${name}[${index}]`, "must be a non-empty string");
      }
    }
  }
  if (workload.parent_plan !== null) {
    exactKeys(workload.parent_plan, ["id", "profile"], "workload.parent_plan");
    identifier(workload.parent_plan.id, "workload.parent_plan.id");
    identifier(workload.parent_plan.profile, "workload.parent_plan.profile");
  }

  const safeUncertainty = workload.uncertainty_flags.every(
    (flag) => flag === "parent_plan_missing",
  );
  const explicitCapabilities = ROUTING_HINT_SOURCE.test(
    workload.sources.required_capabilities,
  );
  const unresolvedFailure =
    workload.retry.count > 0 ||
    workload.history.changes_requested > 0 ||
    workload.history.sessions_failed > 0 ||
    workload.diagnostics.history_errors.length > 0;
  const expectedRejections = [];
  if (key.role !== "implementer") expectedRejections.push("role_not_implementer");
  if (workload.work_kind !== "implementation") {
    expectedRejections.push("work_not_bounded_implementation");
  }
  if (workload.complexity !== "low") expectedRejections.push("complexity_not_low");
  if (workload.risk !== "low") expectedRejections.push("risk_not_low");
  if (workload.context_size.band === "large") expectedRejections.push("context_not_bounded");
  if (!explicitCapabilities) expectedRejections.push("capabilities_not_explicit");
  if (workload.verification_burden !== "objective") {
    expectedRejections.push("verification_not_objective");
  }
  if (unresolvedFailure) expectedRejections.push("unresolved_failure_history");
  if (!safeUncertainty) expectedRejections.push("safety_evidence_uncertain");
  if (
    JSON.stringify(workload.lower_tier.rejection_reasons) !==
    JSON.stringify(expectedRejections)
  ) {
    fail("workload.lower_tier.rejection_reasons", "does not match the failed normalized gates");
  }
  const lowerTierConsistent =
    key.role === "implementer" &&
    workload.work_kind === "implementation" &&
    workload.complexity === "low" &&
    workload.risk === "low" &&
    workload.context_size.band !== "large" &&
    explicitCapabilities &&
    workload.verification_burden === "objective" &&
    workload.approval === "not_required" &&
    workload.retry.count === 0 &&
    workload.history.changes_requested === 0 &&
    workload.history.sessions_failed === 0 &&
    workload.diagnostics.plan_errors.length === 0 &&
    workload.diagnostics.history_errors.length === 0 &&
    workload.diagnostics.strict_planning_contract === false &&
    ROUTING_HINT_SOURCE.test(workload.sources.work_kind) &&
    safeUncertainty;
  if (workload.lower_tier.eligible !== lowerTierConsistent) {
    fail("workload.lower_tier.eligible", "contradicts normalized safety evidence");
  }
  if (
    workload.lower_tier.eligible !==
    (workload.lower_tier.rejection_reasons.length === 0)
  ) {
    fail("workload.lower_tier", "eligible must match an empty rejection list");
  }
  const expectedMinimum = workload.lower_tier.eligible
    ? config.tiers[0].id
    : config.policy.high_tier;
  if (workload.minimum_tier !== expectedMinimum) {
    fail("workload.minimum_tier", `must be ${expectedMinimum} for the normalized evidence`);
  }
}

function validateHistory(history) {
  if (!Array.isArray(history)) {
    fail("history", "must be an array of prior decision records");
  }
  return history.map((entry, index) => {
    const label = `history[${index}]`;
    if (!isObject(entry) || !isObject(entry.key) || !isObject(entry.chosen)) {
      fail(label, "must contain key and chosen objects");
    }
    const key = validateDecisionKey(entry.key);
    nonNegativeInteger(entry.step, `${label}.step`);
    identifier(entry.chosen.candidate, `${label}.chosen.candidate`);
    identifier(entry.chosen.provider, `${label}.chosen.provider`);
    const reasonCode = entry.reason?.code ?? null;
    if (reasonCode !== null && typeof reasonCode !== "string") {
      fail(`${label}.reason.code`, "must be a string or null");
    }
    return { key, step: entry.step, chosen: entry.chosen, reason_code: reasonCode };
  });
}

function validateImplementerDecision(decision, key, config, tierRanks) {
  if (decision === null) {
    return null;
  }
  if (key.role !== "reviewer") {
    fail("implementer decision", "is only accepted for Reviewer selection");
  }
  if (!isObject(decision)) {
    fail("implementer decision", "must be an object or null");
  }
  exactKeys(
    decision,
    ["task", "attempt", "candidate", "provider", "tier"],
    "implementer decision",
  );
  if (decision.task !== key.task) {
    fail("implementer decision.task", `does not match decision key task ${key.task}`);
  }
  if (decision.attempt !== key.attempt) {
    fail(
      "implementer decision.attempt",
      `does not match decision key attempt ${key.attempt}`,
    );
  }
  identifier(decision.candidate, "implementer decision.candidate");
  identifier(decision.provider, "implementer decision.provider");
  if (!tierRanks.has(decision.tier)) {
    fail("implementer decision.tier", `references unknown tier ${String(decision.tier)}`);
  }
  const candidate = config.candidates.find((entry) => entry.id === decision.candidate);
  if (candidate === undefined) {
    fail("implementer decision.candidate", `references unknown candidate ${decision.candidate}`);
  }
  if (candidate.provider !== decision.provider || candidate.tier !== decision.tier) {
    fail("implementer decision", "provider and tier must match the configured candidate");
  }
  if (!candidate.roles.includes("implementer")) {
    fail("implementer decision.candidate", "must be eligible for the Implementer Role");
  }
  return decision;
}

function workloadSummary(workload) {
  return {
    task: workload.task_id,
    role: workload.role,
    work_kind: workload.work_kind,
    parent_plan:
      workload.parent_plan === null
        ? null
        : { id: workload.parent_plan.id, profile: workload.parent_plan.profile },
    complexity: workload.complexity,
    risk: workload.risk,
    context_band: workload.context_size.band,
    required_capabilities: [...workload.required_capabilities],
    verification: workload.verification_burden,
    budgets: { cost: workload.budgets.cost, latency: workload.budgets.latency },
    approval: workload.approval,
    retry: { count: workload.retry.count, limit: workload.retry.limit },
    history: { ...workload.history },
    uncertainty_flags: [...workload.uncertainty_flags],
    minimum_tier: workload.minimum_tier,
    lower_tier: {
      eligible: workload.lower_tier.eligible,
      rejection_reasons: [...workload.lower_tier.rejection_reasons],
    },
    sources: { ...workload.sources },
  };
}

function compareVectors(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

// The documented lexicographic fitness tuple, compared with every component
// normalized so that a larger value is better:
//   1. provider_distinct - Reviewer only: 1 when the candidate's provider
//      differs from the Implementer decision's provider, otherwise 0.
//   2. tier_surplus      - the smallest tier above the safety floor wins.
//   3. capability_surplus - the fewest unneeded declared capabilities win.
//   4. latency           - a faster (lower-indexed) latency class wins.
//   5. cost              - a cheaper (lower-indexed) cost class wins.
function fitnessVector(
  candidate,
  {
    providerDistinct,
    requiredFloorRank,
    requiredCapabilities,
    tierRanks,
    costRanks,
    latencyRanks,
  },
) {
  return [
    providerDistinct,
    -(tierRanks.get(candidate.tier) - requiredFloorRank),
    -(candidate.capabilities.length - requiredCapabilities.length),
    -latencyRanks.get(candidate.latency_class),
    -costRanks.get(candidate.cost_class),
  ];
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
  if (denominator === 0n) {
    fail("distribution", "cannot contain a zero denominator");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const gcd = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: (sign * numerator) / gcd,
    denominator: (sign * denominator) / gcd,
  };
}

function decimalFraction(value) {
  const [coefficient, exponentText = "0"] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent);
  } else if (exponent < 0) {
    denominator *= 10n ** BigInt(-exponent);
  }
  return normalizedFraction(numerator, denominator);
}

function addFractions(left, right) {
  return normalizedFraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function deficitFraction(observed, count, weight, totalWeight) {
  return normalizedFraction(
    BigInt(observed) * weight.numerator * totalWeight.denominator -
      BigInt(count) * totalWeight.numerator * weight.denominator,
    weight.denominator * totalWeight.numerator,
  );
}

function compareFractions(left, right) {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function selectCandidate({
  config,
  workload,
  key,
  history = [],
  implementerDecision = null,
}) {
  const normalizedConfig = validateRoutingConfig(config);
  const validatedKey = validateDecisionKey(key);
  validateWorkload(workload, validatedKey, normalizedConfig);
  const priorDecisions = validateHistory(history);
  const tierRanks = new Map(normalizedConfig.tiers.map(({ id, rank }) => [id, rank]));
  const decision = validateImplementerDecision(
    implementerDecision,
    validatedKey,
    normalizedConfig,
    tierRanks,
  );
  const keyString = decisionKeyString(validatedKey);

  // Explicit step index: prior recorded steps of this exact key determine the
  // index this selection occupies. Steps are bounded by the configured
  // per-action fallback limit; the key itself never carries mutable state.
  const priorSteps = priorDecisions.filter((entry) => sameKey(entry.key, validatedKey));
  const stepNumbers = priorSteps.map((entry) => entry.step).sort((a, b) => a - b);
  stepNumbers.forEach((number, index) => {
    if (number !== index) {
      fail("history", `contains non-contiguous steps for ${keyString}`);
    }
  });
  const step = stepNumbers.length;
  const limits = normalizedConfig.policy.limits;
  if (step > limits.fallbacks_per_action) {
    throw new RoutingPolicyError(
      `history: fallback limit ${limits.fallbacks_per_action} is exhausted for ${keyString}`,
    );
  }
  const priorCandidates = new Set(priorSteps.map((entry) => entry.chosen.candidate));
  const escalationsUsed = priorDecisions.filter(
    (entry) =>
      entry.key.task === validatedKey.task &&
      ESCALATION_REASON_CODES.has(entry.reason_code),
  ).length;
  if (escalationsUsed > limits.escalations_per_task) {
    fail(
      "history",
      `exceeds escalation limit ${limits.escalations_per_task} for ${validatedKey.task}`,
    );
  }

  const costRanks = new Map(normalizedConfig.cost_classes.map((id, index) => [id, index]));
  const latencyRanks = new Map(
    normalizedConfig.latency_classes.map((id, index) => [id, index]),
  );
  const highRank = tierRanks.get(normalizedConfig.policy.high_tier);
  const workloadMinRank = tierRanks.get(workload.minimum_tier);

  // Planning, Reviewer, unknown, and conservative workloads keep the high
  // tier. A workload minimum below the high tier is honored only when the
  // normalized lower-tier gate fully passed for bounded Implementer work.
  // Nothing later in this policy (budgets, deficits, overrides) lowers it.
  const lowerTierTrusted =
    validatedKey.role === "implementer" &&
    workload.work_kind === "implementation" &&
    workload.lower_tier.eligible === true &&
    workload.lower_tier.rejection_reasons.length === 0;
  const baseMinRank = lowerTierTrusted
    ? workloadMinRank
    : Math.max(workloadMinRank, highRank);

  // Reviewer safety invariant: a Reviewer is never weaker than the recorded
  // Implementer decision for the same Task attempt. Without that decision the
  // Reviewer floor is conservatively the high tier.
  const reviewerFloorRank =
    validatedKey.role === "reviewer"
      ? decision === null
        ? highRank
        : tierRanks.get(decision.tier)
      : null;
  const requiredFloorRank = Math.max(baseMinRank, reviewerFloorRank ?? 0);

  const budgetCostRank = costRanks.get(workload.budgets.cost);
  const budgetLatencyRank = latencyRanks.get(workload.budgets.latency);

  const considered = [...normalizedConfig.candidates]
    .sort((left, right) => compareText(left.id, right.id))
    .map((candidate) => {
      const reasons = [];
      if (!candidate.enabled) {
        reasons.push("candidate_disabled");
      }
      if (!candidate.roles.includes(validatedKey.role)) {
        reasons.push("role_ineligible");
      }
      if (priorCandidates.has(candidate.id)) {
        reasons.push("prior_step_candidate");
      }
      if (
        workload.required_capabilities.some(
          (capability) => !candidate.capabilities.includes(capability),
        )
      ) {
        reasons.push("capability_missing");
      }
      if (candidate.context_limit < workload.context_size.estimated_tokens) {
        reasons.push("context_capacity_insufficient");
      }
      if (costRanks.get(candidate.cost_class) > budgetCostRank) {
        reasons.push("cost_budget_exceeded");
      }
      if (latencyRanks.get(candidate.latency_class) > budgetLatencyRank) {
        reasons.push("latency_budget_exceeded");
      }
      const rank = tierRanks.get(candidate.tier);
      if (rank < baseMinRank) {
        reasons.push("tier_below_minimum");
      }
      if (reviewerFloorRank !== null && rank < reviewerFloorRank) {
        reasons.push("tier_below_reviewer_floor");
      }
      return {
        candidate: candidate.id,
        provider: candidate.provider,
        model: candidate.model,
        tier: candidate.tier,
        eligible: reasons.length === 0,
        reasons,
      };
    });

  const candidateById = new Map(
    normalizedConfig.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const eligible = considered.filter((entry) => entry.eligible);
  if (eligible.length === 0) {
    throw new NoEligibleCandidateError(
      `No eligible routing candidate for ${keyString}`,
      deepFreeze(considered),
    );
  }

  const vectors = new Map(
    eligible.map((entry) => [
      entry.candidate,
      fitnessVector(candidateById.get(entry.candidate), {
        providerDistinct:
          decision !== null && entry.provider !== decision.provider ? 1 : 0,
        requiredFloorRank,
        requiredCapabilities: workload.required_capabilities,
        tierRanks,
        costRanks,
        latencyRanks,
      }),
    ]),
  );
  let bestVector = null;
  for (const vector of vectors.values()) {
    if (bestVector === null || compareVectors(vector, bestVector) > 0) {
      bestVector = vector;
    }
  }
  // "Materially equivalent" is mechanical: the same best fitness tuple after
  // every hard gate. Only these candidates participate in distribution.
  const equivalent = eligible.filter(
    (entry) => compareVectors(vectors.get(entry.candidate), bestVector) === 0,
  );
  const fitnessWinner = equivalent[0];

  // Provider distribution deficit inside the materially equivalent set. With
  // decision counts and decimal-to-rational weights every comparison below is
  // exact. Reduced numerator/denominator strings preserve that evidence without
  // division or float accumulation affecting a routing choice.
  const targets = normalizedConfig.policy.provider_targets;
  const weightByProvider = new Map(
    targets.map(({ provider, weight }) => [provider, decimalFraction(weight)]),
  );
  const totalWeight = [...weightByProvider.values()].reduce(
    (sum, weight) => addFractions(sum, weight),
    { numerator: 0n, denominator: 1n },
  );
  const window = normalizedConfig.policy.distribution_window;
  const windowRows = priorDecisions.slice(-window);
  const countByProvider = new Map(targets.map(({ provider }) => [provider, 0]));
  for (const row of windowRows) {
    if (countByProvider.has(row.chosen.provider)) {
      countByProvider.set(
        row.chosen.provider,
        countByProvider.get(row.chosen.provider) + 1,
      );
    }
  }
  const counts = [...targets]
    .sort((left, right) => compareText(left.provider, right.provider))
    .map(({ provider, weight }) => ({
      provider,
      weight,
      count: countByProvider.get(provider),
    }));

  const equivalentProviders = [...new Set(equivalent.map((entry) => entry.provider))].sort(
    compareText,
  );
  const deficits = equivalentProviders.map((provider) => ({
    provider,
    ...deficitFraction(
      windowRows.length,
      countByProvider.get(provider),
      weightByProvider.get(provider),
      totalWeight,
    ),
  }));
  const applied = equivalentProviders.length > 1;
  let chosenEntry = fitnessWinner;
  if (applied) {
    let bestDeficit = deficits[0];
    for (const entry of deficits.slice(1)) {
      if (compareFractions(entry, bestDeficit) > 0) {
        bestDeficit = entry;
      }
    }
    chosenEntry = equivalent.find((entry) => entry.provider === bestDeficit.provider);
  }

  return deepFreeze({
    key: validatedKey,
    key_string: keyString,
    step,
    parent_step: step === 0 ? null : step - 1,
    fallback: {
      next_step: step + 1,
      available: step + 1 <= limits.fallbacks_per_action,
    },
    escalation: {
      used: escalationsUsed,
      limit: limits.escalations_per_task,
      available: escalationsUsed < limits.escalations_per_task,
    },
    minimum_tier: [...tierRanks.entries()].find(
      ([, rank]) => rank === requiredFloorRank,
    )[0],
    workload: workloadSummary(workload),
    considered,
    chosen: {
      candidate: chosenEntry.candidate,
      provider: chosenEntry.provider,
      model: chosenEntry.model,
      tier: chosenEntry.tier,
    },
    fitness: {
      provider_distinct: bestVector[0],
      tier_surplus: -bestVector[1],
      capability_surplus: -bestVector[2],
      latency_rank: -bestVector[3],
      cost_rank: -bestVector[4],
      vector: bestVector,
    },
    distribution: {
      window,
      observed: windowRows.length,
      counts,
      equivalent: equivalent.map((entry) => entry.candidate),
      deficits: deficits.map(({ provider, numerator, denominator }) => ({
        provider,
        numerator: String(numerator),
        denominator: String(denominator),
      })),
      applied,
      changed_winner: chosenEntry.candidate !== fitnessWinner.candidate,
    },
    same_provider_review:
      decision !== null && chosenEntry.provider === decision.provider
        ? {
            implementer: {
              candidate: decision.candidate,
              provider: decision.provider,
            },
            cross_provider_disqualified: considered
              .filter((entry) => entry.provider !== decision.provider)
              .map((entry) => ({ candidate: entry.candidate, reasons: entry.reasons })),
          }
        : null,
  });
}
