import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateReviewMetadata } from "./contracts.js";
import { TaskStore, parseDocumentFile } from "./documents.js";
import { collectPlanProposals } from "./plan-dashboard.js";
import {
  markdownSection,
  validatePlanMetadata,
  validatePlanSections,
} from "./plans.js";
import { readPlanOrder } from "./progression.js";
import { validateSessionLedgerRow } from "./sessions.js";
import { validateCommand } from "./workers.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_SELECTOR = /^(?:\*|task-[0-9]{4,})$/;
const PLAN_SELECTOR = /^[a-z0-9][a-z0-9-]*$/;
const ROUTED_ROLES = new Set(["implementer", "reviewer"]);
const WORK_KINDS = new Set(["planning", "implementation", "unknown"]);
const BANDS = new Set(["low", "medium", "high", "unknown"]);
const VERIFICATION = new Set(["objective", "subjective", "unknown"]);

export class RoutingConfigError extends TypeError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "RoutingConfigError";
  }
}

function fail(label, message) {
  throw new RoutingConfigError(`${label}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  if (!isObject(value)) {
    fail(label, "must be an object");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(label, `is missing required field ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label}.${key}`, "is not allowed");
    }
  }
}

function nonEmptyString(value, label, pattern = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(label, "must be a non-empty string");
  }
  const normalized = value.trim();
  if (pattern !== null && !pattern.test(normalized)) {
    fail(label, `has an invalid value: ${normalized}`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(label, "must be a positive safe integer");
  }
  return value;
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(label, "must be a finite positive number");
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) {
    fail(label, `has an unknown value: ${String(value)}`);
  }
  return value;
}

function uniqueStrings(value, label, { allowEmpty = false, allowed = null } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(label, `must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const normalized = value.map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`, IDENTIFIER),
  );
  if (new Set(normalized).size !== normalized.length) {
    fail(label, "must not contain duplicates");
  }
  if (allowed !== null) {
    normalized.forEach((entry, index) => {
      if (!allowed.has(entry)) {
        fail(`${label}[${index}]`, `references unknown value ${entry}`);
      }
    });
  }
  return normalized;
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

function validateTiers(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("routing.tiers", "must be a non-empty array");
  }
  const tiers = value.map((entry, index) => {
    const label = `routing.tiers[${index}]`;
    exactKeys(entry, ["id", "rank"], [], label);
    return {
      id: nonEmptyString(entry.id, `${label}.id`, IDENTIFIER),
      rank: positiveInteger(entry.rank, `${label}.rank`),
    };
  });
  if (new Set(tiers.map(({ id }) => id)).size !== tiers.length) {
    fail("routing.tiers", "contains duplicate ids");
  }
  if (new Set(tiers.map(({ rank }) => rank)).size !== tiers.length) {
    fail("routing.tiers", "contains duplicate ranks");
  }
  return tiers.sort((left, right) => left.rank - right.rank);
}

function validateCandidates(value, catalogs) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("routing.candidates", "must be a non-empty array");
  }
  const candidates = value.map((entry, index) => {
    const label = `routing.candidates[${index}]`;
    exactKeys(
      entry,
      [
        "id",
        "provider",
        "model",
        "tier",
        "roles",
        "command",
        "enabled",
        "context_limit",
        "capabilities",
        "cost_class",
        "latency_class",
      ],
      [],
      label,
    );
    const roles = uniqueStrings(entry.roles, `${label}.roles`, {
      allowed: ROUTED_ROLES,
    });
    let command;
    try {
      command = [...validateCommand(entry.command, `candidate ${entry.id}`)];
    } catch (error) {
      throw new RoutingConfigError(`${label}.command: ${error.message}`, {
        cause: error,
      });
    }
    if (typeof entry.enabled !== "boolean") {
      fail(`${label}.enabled`, "must be a boolean");
    }
    return {
      id: nonEmptyString(entry.id, `${label}.id`, IDENTIFIER),
      provider: nonEmptyString(entry.provider, `${label}.provider`, IDENTIFIER),
      model: nonEmptyString(entry.model, `${label}.model`),
      tier: nonEmptyString(entry.tier, `${label}.tier`, IDENTIFIER),
      roles,
      command,
      enabled: entry.enabled,
      context_limit: positiveInteger(entry.context_limit, `${label}.context_limit`),
      capabilities: uniqueStrings(entry.capabilities, `${label}.capabilities`, {
        allowEmpty: true,
        allowed: catalogs.capabilities,
      }),
      cost_class: nonEmptyString(entry.cost_class, `${label}.cost_class`, IDENTIFIER),
      latency_class: nonEmptyString(
        entry.latency_class,
        `${label}.latency_class`,
        IDENTIFIER,
      ),
    };
  });

  const ids = new Set();
  const providerModelRoles = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) {
      fail("routing.candidates", `contains duplicate id ${candidate.id}`);
    }
    ids.add(candidate.id);
    if (!catalogs.tiers.has(candidate.tier)) {
      fail(
        `routing.candidates.${candidate.id}.tier`,
        `references unknown tier ${candidate.tier}`,
      );
    }
    if (!catalogs.costClasses.has(candidate.cost_class)) {
      fail(
        `routing.candidates.${candidate.id}.cost_class`,
        `references unknown cost class ${candidate.cost_class}`,
      );
    }
    if (!catalogs.latencyClasses.has(candidate.latency_class)) {
      fail(
        `routing.candidates.${candidate.id}.latency_class`,
        `references unknown latency class ${candidate.latency_class}`,
      );
    }
    for (const role of candidate.roles) {
      const key = `${candidate.provider}\u0000${candidate.model}\u0000${role}`;
      if (providerModelRoles.has(key)) {
        fail(
          "routing.candidates",
          `duplicates provider/model/Role ${candidate.provider}/${candidate.model}/${role}`,
        );
      }
      providerModelRoles.add(key);
    }
  }
  for (const role of ROUTED_ROLES) {
    if (!candidates.some((candidate) => candidate.enabled && candidate.roles.includes(role))) {
      fail("routing.candidates", `has no enabled candidate for Role ${role}`);
    }
  }
  return candidates;
}

function validatePolicy(value, catalogs, providers) {
  exactKeys(
    value,
    [
      "high_tier",
      "distribution_window",
      "provider_targets",
      "limits",
      "default_budgets",
    ],
    [],
    "routing.policy",
  );
  const highTier = nonEmptyString(
    value.high_tier,
    "routing.policy.high_tier",
    IDENTIFIER,
  );
  if (!catalogs.tiers.has(highTier)) {
    fail("routing.policy.high_tier", `references unknown tier ${highTier}`);
  }
  if (!Array.isArray(value.provider_targets) || value.provider_targets.length === 0) {
    fail("routing.policy.provider_targets", "must be a non-empty array");
  }
  const providerTargets = value.provider_targets.map((entry, index) => {
    const label = `routing.policy.provider_targets[${index}]`;
    exactKeys(entry, ["provider", "weight"], [], label);
    return {
      provider: nonEmptyString(entry.provider, `${label}.provider`, IDENTIFIER),
      weight: finitePositive(entry.weight, `${label}.weight`),
    };
  });
  const targetProviders = new Set(providerTargets.map(({ provider }) => provider));
  if (targetProviders.size !== providerTargets.length) {
    fail("routing.policy.provider_targets", "contains duplicate providers");
  }
  for (const provider of providers) {
    if (!targetProviders.has(provider)) {
      fail("routing.policy.provider_targets", `is missing provider ${provider}`);
    }
  }
  for (const provider of targetProviders) {
    if (!providers.has(provider)) {
      fail("routing.policy.provider_targets", `references unknown provider ${provider}`);
    }
  }

  exactKeys(
    value.limits,
    ["fallbacks_per_action", "escalations_per_task"],
    [],
    "routing.policy.limits",
  );
  exactKeys(
    value.default_budgets,
    ["cost", "latency"],
    [],
    "routing.policy.default_budgets",
  );
  const cost = nonEmptyString(
    value.default_budgets.cost,
    "routing.policy.default_budgets.cost",
    IDENTIFIER,
  );
  const latency = nonEmptyString(
    value.default_budgets.latency,
    "routing.policy.default_budgets.latency",
    IDENTIFIER,
  );
  if (!catalogs.costClasses.has(cost)) {
    fail("routing.policy.default_budgets.cost", `references unknown cost class ${cost}`);
  }
  if (!catalogs.latencyClasses.has(latency)) {
    fail(
      "routing.policy.default_budgets.latency",
      `references unknown latency class ${latency}`,
    );
  }
  return {
    high_tier: highTier,
    distribution_window: positiveInteger(
      value.distribution_window,
      "routing.policy.distribution_window",
    ),
    provider_targets: providerTargets,
    limits: {
      fallbacks_per_action: positiveInteger(
        value.limits.fallbacks_per_action,
        "routing.policy.limits.fallbacks_per_action",
      ),
      escalations_per_task: positiveInteger(
        value.limits.escalations_per_task,
        "routing.policy.limits.escalations_per_task",
      ),
    },
    default_budgets: { cost, latency },
  };
}

function validateHints(value, catalogs) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("routing.hints", "must be an array");
  }
  const selectors = new Set();
  return value.map((entry, index) => {
    const label = `routing.hints[${index}]`;
    exactKeys(
      entry,
      [
        "selector",
        "work_kind",
        "complexity",
        "risk",
        "required_capabilities",
        "verification",
        "cost_budget",
        "latency_budget",
      ],
      [],
      label,
    );
    exactKeys(entry.selector, ["task", "plan"], [], `${label}.selector`);
    const task =
      entry.selector.task === null
        ? null
        : nonEmptyString(entry.selector.task, `${label}.selector.task`, /^task-[0-9]{4,}$/);
    const plan =
      entry.selector.plan === null
        ? null
        : nonEmptyString(entry.selector.plan, `${label}.selector.plan`, PLAN_SELECTOR);
    if ((task === null) === (plan === null)) {
      fail(`${label}.selector`, "must select exactly one Task or plan");
    }
    const selectorKey = task === null ? `plan:${plan}` : `task:${task}`;
    if (selectors.has(selectorKey)) {
      fail("routing.hints", `contains duplicate selector ${selectorKey}`);
    }
    selectors.add(selectorKey);
    const requiredCapabilities = uniqueStrings(
      entry.required_capabilities,
      `${label}.required_capabilities`,
      { allowEmpty: true, allowed: catalogs.capabilities },
    );
    const costBudget = nonEmptyString(
      entry.cost_budget,
      `${label}.cost_budget`,
      IDENTIFIER,
    );
    const latencyBudget = nonEmptyString(
      entry.latency_budget,
      `${label}.latency_budget`,
      IDENTIFIER,
    );
    if (!catalogs.costClasses.has(costBudget)) {
      fail(`${label}.cost_budget`, `references unknown cost class ${costBudget}`);
    }
    if (!catalogs.latencyClasses.has(latencyBudget)) {
      fail(`${label}.latency_budget`, `references unknown latency class ${latencyBudget}`);
    }
    return {
      selector: { task, plan },
      work_kind: enumValue(entry.work_kind, WORK_KINDS, `${label}.work_kind`),
      complexity: enumValue(entry.complexity, BANDS, `${label}.complexity`),
      risk: enumValue(entry.risk, BANDS, `${label}.risk`),
      required_capabilities: requiredCapabilities,
      verification: enumValue(entry.verification, VERIFICATION, `${label}.verification`),
      cost_budget: costBudget,
      latency_budget: latencyBudget,
    };
  });
}

function validateOverrides(value, candidateMap) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("routing.overrides", "must be an array");
  }
  const selectors = new Set();
  return value.map((entry, index) => {
    const label = `routing.overrides[${index}]`;
    exactKeys(entry, ["selector", "candidate", "allow_fallback"], [], label);
    exactKeys(entry.selector, ["task", "role"], [], `${label}.selector`);
    const task = nonEmptyString(
      entry.selector.task,
      `${label}.selector.task`,
      TASK_SELECTOR,
    );
    const role = enumValue(
      entry.selector.role,
      ROUTED_ROLES,
      `${label}.selector.role`,
    );
    const selectorKey = `${task}:${role}`;
    if (selectors.has(selectorKey)) {
      fail("routing.overrides", `contains duplicate selector ${selectorKey}`);
    }
    selectors.add(selectorKey);
    const candidateId = nonEmptyString(
      entry.candidate,
      `${label}.candidate`,
      IDENTIFIER,
    );
    const candidate = candidateMap.get(candidateId);
    if (candidate === undefined) {
      fail(`${label}.candidate`, `references unknown candidate ${candidateId}`);
    }
    if (!candidate.roles.includes(role)) {
      fail(`${label}.candidate`, `candidate ${candidateId} is ineligible for Role ${role}`);
    }
    if (typeof entry.allow_fallback !== "boolean") {
      fail(`${label}.allow_fallback`, "must be a boolean");
    }
    return {
      selector: { task, role },
      candidate: candidateId,
      allow_fallback: entry.allow_fallback,
    };
  });
}

export function validateRoutingConfig(value) {
  exactKeys(
    value,
    [
      "schema",
      "tiers",
      "capabilities",
      "cost_classes",
      "latency_classes",
      "candidates",
      "policy",
    ],
    ["hints", "overrides"],
    "routing",
  );
  if (value.schema !== "aios.routing/v1") {
    fail("routing.schema", "must be aios.routing/v1");
  }
  const tiers = validateTiers(value.tiers);
  const capabilities = uniqueStrings(value.capabilities, "routing.capabilities", {
    allowEmpty: true,
  });
  const costClasses = uniqueStrings(value.cost_classes, "routing.cost_classes");
  const latencyClasses = uniqueStrings(value.latency_classes, "routing.latency_classes");
  const catalogs = {
    tiers: new Set(tiers.map(({ id }) => id)),
    capabilities: new Set(capabilities),
    costClasses: new Set(costClasses),
    latencyClasses: new Set(latencyClasses),
  };
  const candidates = validateCandidates(value.candidates, catalogs);
  const providers = new Set(candidates.map(({ provider }) => provider));
  const policy = validatePolicy(value.policy, catalogs, providers);
  const hints = validateHints(value.hints, catalogs);
  const overrides = validateOverrides(
    value.overrides,
    new Map(candidates.map((candidate) => [candidate.id, candidate])),
  );
  return deepFreeze({
    schema: "aios.routing/v1",
    tiers,
    capabilities,
    cost_classes: costClasses,
    latency_classes: latencyClasses,
    candidates,
    policy,
    hints,
    overrides,
  });
}

export function parseExecutionConfig(value) {
  if (value?.schema === "aios.routing/v1") {
    return deepFreeze({ kind: "routing", config: validateRoutingConfig(value) });
  }
  if (value?.schema !== "aios.assignments/v1") {
    fail("config.schema", "must be aios.assignments/v1 or aios.routing/v1");
  }
  exactKeys(value, ["schema", "assignments"], [], "assignments");
  if (!isObject(value.assignments)) {
    fail("assignments.assignments", "must be an object");
  }
  const assignments = {};
  for (const [role, command] of Object.entries(value.assignments)) {
    if (!new Set(["implementer", "reviewer", "approver"]).has(role)) {
      fail(`assignments.assignments.${role}`, "is an unknown Role");
    }
    try {
      assignments[role] = [...validateCommand(command, role)];
    } catch (error) {
      throw new RoutingConfigError(`assignments.assignments.${role}: ${error.message}`, {
        cause: error,
      });
    }
  }
  return deepFreeze({
    kind: "assignments",
    config: { schema: "aios.assignments/v1", assignments },
  });
}

export async function loadExecutionConfig(filePath) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new RoutingConfigError(`Unable to read execution config ${filePath}`, {
      cause: error,
    });
  }
  return parseExecutionConfig(value);
}

function planningContract(task) {
  const objective = markdownSection(task.body, "Objective") ?? "";
  const criteria = markdownSection(task.body, "Acceptance Criteria") ?? "";
  const constraints = markdownSection(task.body, "Constraints") ?? "";
  const objectiveParagraph = objective
    .split(/\r?\n[ \t]*\r?\n/, 1)[0]
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
  const match = new RegExp(
    `^(?:produce|create|write|deliver|generate|author)\\b.*\\b(?:plan|proposals?)\\b.*\\bplans[\\\\/]([a-z0-9][a-z0-9-]*)[\\\\/]?`,
    "i",
  ).exec(objectiveParagraph);
  if (match === null) {
    return false;
  }
  const beforePlan = match[0].split(/\b(?:plan|proposals?)\b/i, 1)[0];
  if (
    /\b(?:no|not|without|inspect|inspection|status|report|analysis|analyze|analyse)\b/i.test(
      beforePlan,
    )
  ) {
    return false;
  }
  const planId = match[1];
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const planPath = `plans[\\\\/]${escape(planId)}[\\\\/]?`;
  const writeConstraint = new RegExp(
    `^(?:(?:This is a planning Task|This Task is for planning)\\.[ \\t]+)?(?:The[ \\t]+Implementer[ \\t]+)?(?:writes?|may[ \\t]+write|write)[ \\t]+only[ \\t]+(?:under|within)[ \\t]+${planPath}(?:[.;]|$)`,
    "i",
  );
  const itemStarts = [
    ...constraints.matchAll(/^(?:[-+*]|[0-9]+\.)[ \t]+/gm),
  ];
  const constraintItems = itemStarts.map((entry, index) => {
    const start = entry.index + entry[0].length;
    const end = itemStarts[index + 1]?.index ?? constraints.length;
    return constraints
      .slice(start, end)
      .replaceAll("`", "")
      .replace(/\s+/g, " ")
      .trim();
  });
  const commands = [...criteria.matchAll(/`([^`\r\n]+)`/g)].map((entry) =>
    entry[1].trim(),
  );
  const adoptCheck = new RegExp(
    `^(?:node[ \\t]+src[\\\\/]cli\\.js|npm[ \\t]+run[ \\t]+aios[ \\t]+--)[ \\t]+adopt[ \\t]+${planPath}[ \\t]+--check$`,
    "i",
  );
  return (
    constraintItems.some((item) => writeConstraint.test(item)) &&
    commands.some((command) => adoptCheck.test(command))
  );
}

function structuralComplexity(task) {
  const criteria = markdownSection(task.body, "Acceptance Criteria") ?? "";
  const constraints = markdownSection(task.body, "Constraints") ?? "";
  const itemCount = (criteria.match(/^(?:[-+*]|[0-9]+\.)[ \t]+\S/gm) ?? []).length;
  const constraintCount = (constraints.match(/^(?:[-+*]|[0-9]+\.)[ \t]+\S/gm) ?? [])
    .length;
  const bytes = Buffer.byteLength(task.raw, "utf8");
  if (itemCount >= 8 || constraintCount >= 5 || bytes > 12_000) {
    return "high";
  }
  if (itemCount >= 4 || constraintCount >= 2 || bytes > 5_000) {
    return "medium";
  }
  return "low";
}

function contextSize(task) {
  const bytes = Buffer.byteLength(task.raw, "utf8");
  return {
    bytes,
    estimated_tokens: Math.ceil(bytes / 4),
    band: bytes <= 8_000 ? "small" : bytes <= 32_000 ? "medium" : "large",
  };
}

function historyCounters(task, reviews, sessions) {
  const errors = [];
  const validReviews = [];
  reviews.forEach((review, index) => {
    try {
      validateReviewMetadata(review?.metadata, review?.metadata?.id ?? null);
      if (typeof review.body !== "string" || review.body.trim().length === 0) {
        throw new TypeError("Review body must be non-empty");
      }
      if (review.metadata.project !== task.metadata.project) {
        throw new TypeError("Review project does not match the Task");
      }
      validReviews.push(review);
    } catch (error) {
      errors.push(`reviews[${index}]: ${error.message}`);
    }
  });
  const validSessions = [];
  sessions.forEach((session, index) => {
    try {
      validSessions.push(validateSessionLedgerRow(session, index));
    } catch (error) {
      errors.push(`sessions[${index}]: ${error.message}`);
    }
  });
  const taskReviews = validReviews.filter(
    (review) => review.metadata.task === task.metadata.id,
  );
  const taskSessions = validSessions.filter(
    (session) => session.task === task.metadata.id,
  );
  return {
    counters: {
      reviews_total: taskReviews.length,
      changes_requested: taskReviews.filter(
        (review) => review.metadata.verdict === "changes_requested",
      ).length,
      sessions_failed: taskSessions.filter((session) => session.outcome === "failed").length,
      capacity_deferred: taskSessions.filter(
        (session) => session.outcome === "capacity_deferred",
      ).length,
    },
    errors,
  };
}

async function discoverParentPlan(root, task, store) {
  const discovery = await collectPlanProposals(root);
  const errors = discovery.errors.map((entry) => `${entry.plan}: ${entry.message}`);
  const matches = [];
  const plans = [...discovery.plans].sort(
    (left, right) => left.directory.localeCompare(right.directory),
  );
  for (const plan of plans) {
    const planDirectory = path.join(path.resolve(root), "plans", plan.directory);
    let planMetadata;
    let planBody;
    try {
      const raw = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
      ({ metadata: planMetadata, body: planBody } = parseDocumentFile(raw, "PLAN.md"));
    } catch (error) {
      errors.push(`${plan.directory}: ${error.message}`);
      continue;
    }
    if (!plan.adopted) {
      const execution = markdownSection(planBody, "Execution Order") ?? "";
      if (/\bP-[0-9]{2,}\b/.test(planBody) && /\btask-[0-9]{4,}\b/.test(execution)) {
        errors.push(
          `${plan.directory}: PLAN.md mixes proposal placeholders with an adopted Task Execution Order`,
        );
      }
      continue;
    }
    const metadataProblems = [];
    validatePlanMetadata(planMetadata, plan.directory, metadataProblems);
    const sectionProblems = [];
    validatePlanSections(planBody, sectionProblems);
    metadataProblems.push(...sectionProblems);
    if (metadataProblems.length > 0) {
      errors.push(
        ...metadataProblems.map((problem) => `${plan.directory}: ${problem}`),
      );
      continue;
    }
    try {
      const order = await readPlanOrder({
        root,
        planDirectory,
        store,
      });
      if (order.order.includes(task.metadata.id)) {
        matches.push({ id: order.plan, profile: planMetadata.profile });
      }
    } catch (error) {
      errors.push(`${plan.directory}: ${error.message}`);
    }
  }
  matches.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.profile.localeCompare(right.profile),
  );
  errors.sort((left, right) => left.localeCompare(right));
  return { matches, errors };
}

function chooseHint(config, taskId, parentPlan) {
  const taskHint = config.hints.find((hint) => hint.selector.task === taskId) ?? null;
  if (taskHint !== null) {
    return { hint: taskHint, source: `routing.hints.task:${taskId}` };
  }
  if (parentPlan !== null) {
    const planHint =
      config.hints.find((hint) => hint.selector.plan === parentPlan.id) ?? null;
    if (planHint !== null) {
      return { hint: planHint, source: `routing.hints.plan:${parentPlan.id}` };
    }
  }
  return { hint: null, source: null };
}

export async function buildWorkloadContext({
  task,
  role,
  root,
  config,
  reviews = [],
  sessions = [],
  store = new TaskStore(root),
}) {
  if (!task?.metadata || typeof task.raw !== "string" || typeof task.body !== "string") {
    throw new TypeError("task must be a complete validated Task");
  }
  enumValue(role, ROUTED_ROLES, "workload.role");
  const normalizedConfig = validateRoutingConfig(config);
  const discovery = await discoverParentPlan(root, task, store);
  const parentPlan = discovery.matches.length === 1 ? discovery.matches[0] : null;
  const selectedHint = chooseHint(normalizedConfig, task.metadata.id, parentPlan);
  const hint = selectedHint.hint;
  const strictPlanning = planningContract(task);
  const uncertainties = [];
  if (discovery.errors.length > 0) {
    uncertainties.push("parent_plan_invalid");
  }
  if (discovery.matches.length === 0) {
    uncertainties.push("parent_plan_missing");
  } else if (discovery.matches.length > 1) {
    uncertainties.push("parent_plan_ambiguous");
  }

  let workKind = hint?.work_kind ?? (strictPlanning ? "planning" : "unknown");
  let workKindSource = selectedHint.source ?? (strictPlanning ? "task.plan_only_contract" : "default");
  if (strictPlanning && hint !== null && hint.work_kind !== "planning") {
    workKind = "unknown";
    workKindSource = "conflicting_hint_and_task_contract";
    uncertainties.push("work_kind_conflict");
  }
  if (workKind === "unknown") {
    uncertainties.push("work_kind_unknown");
  }

  const complexity = hint?.complexity ?? structuralComplexity(task);
  const complexitySource = hint === null ? "task.structure" : selectedHint.source;
  if (complexity === "unknown") {
    uncertainties.push("complexity_unknown");
  }
  const historyEvidence = historyCounters(task, reviews, sessions);
  const history = historyEvidence.counters;
  if (historyEvidence.errors.length > 0) {
    uncertainties.push("history_invalid");
  }
  const unresolvedFailure =
    task.metadata.retry.count > 0 ||
    history.changes_requested > 0 ||
    history.sessions_failed > 0 ||
    historyEvidence.errors.length > 0;
  let risk = hint?.risk ?? "unknown";
  let riskSource = hint === null ? "default" : selectedHint.source;
  if (task.metadata.approval === "required") {
    risk = "high";
    riskSource = "task.approval";
  } else if (unresolvedFailure) {
    risk = "high";
    riskSource =
      historyEvidence.errors.length > 0
        ? "history_validation"
        : task.metadata.retry.count > 0
        ? "task.retry"
        : "review_session_history";
  }
  if (risk === "unknown") {
    uncertainties.push("risk_unknown");
  }
  const requiredCapabilities = hint?.required_capabilities ?? [];
  if (hint === null) {
    uncertainties.push("required_capabilities_unknown");
  }
  const verification = hint?.verification ?? "unknown";
  if (verification === "unknown") {
    uncertainties.push("verification_unknown");
  }
  const size = contextSize(task);

  const rejectionReasons = [];
  if (role !== "implementer") rejectionReasons.push("role_not_implementer");
  if (workKind !== "implementation") rejectionReasons.push("work_not_bounded_implementation");
  if (complexity !== "low") rejectionReasons.push("complexity_not_low");
  if (risk !== "low") rejectionReasons.push("risk_not_low");
  if (size.band === "large") rejectionReasons.push("context_not_bounded");
  if (hint === null) rejectionReasons.push("capabilities_not_explicit");
  if (verification !== "objective") rejectionReasons.push("verification_not_objective");
  if (unresolvedFailure) rejectionReasons.push("unresolved_failure_history");
  if (uncertainties.some((entry) => entry !== "parent_plan_missing")) {
    rejectionReasons.push("safety_evidence_uncertain");
  }
  const uniqueRejections = [...new Set(rejectionReasons)];
  const lowerTierEligible = uniqueRejections.length === 0;
  const lowestTier = normalizedConfig.tiers[0].id;
  const minimumTier = lowerTierEligible
    ? lowestTier
    : normalizedConfig.policy.high_tier;

  return deepFreeze({
    task_id: task.metadata.id,
    role,
    work_kind: workKind,
    parent_plan: parentPlan,
    complexity,
    risk,
    context_size: size,
    required_capabilities: [...requiredCapabilities],
    verification_burden: verification,
    budgets: {
      cost: hint?.cost_budget ?? normalizedConfig.policy.default_budgets.cost,
      latency: hint?.latency_budget ?? normalizedConfig.policy.default_budgets.latency,
    },
    approval: task.metadata.approval,
    retry: { ...task.metadata.retry },
    history,
    uncertainty_flags: [...new Set(uncertainties)].sort(),
    minimum_tier: minimumTier,
    lower_tier: {
      eligible: lowerTierEligible,
      rejection_reasons: uniqueRejections,
    },
    sources: {
      task_id: "task.metadata.id",
      role: "engine.active_role",
      work_kind: workKindSource,
      parent_plan: parentPlan === null ? "plan_scan" : "adopted_plan.execution_order",
      complexity: complexitySource,
      risk: riskSource,
      context_size: "task.raw_utf8",
      required_capabilities: selectedHint.source ?? "default_unknown",
      verification_burden: selectedHint.source ?? "default_unknown",
      budgets: selectedHint.source ?? "routing.policy.default_budgets",
      approval: "task.metadata.approval",
      retry: "task.metadata.retry",
      history: "provided_review_session_history",
      minimum_tier: lowerTierEligible ? "lower_tier_gate" : "routing.policy.high_tier",
      uncertainty_flags: "workload_evidence_validation",
      lower_tier: "documented_lower_tier_gate",
      diagnostics: "plan_and_history_validation",
    },
    diagnostics: {
      strict_planning_contract: strictPlanning,
      plan_errors: discovery.errors,
      history_errors: historyEvidence.errors,
    },
  });
}
