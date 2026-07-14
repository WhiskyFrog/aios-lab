const TASK_STATES = new Set([
  "implement",
  "review",
  "approval",
  "done",
  "blocked",
]);

const APPROVAL_STATES = new Set([
  "not_required",
  "required",
  "approved",
  "rejected",
]);

const ROLES = new Set(["implementer", "reviewer", "approver"]);
const REVIEW_VERDICTS = new Set(["pass", "changes_requested"]);
const RECOVERABLE_FAILURE_KINDS = new Set([
  "verification_failed",
  "context_insufficient",
]);

const STATE_ROLES = Object.freeze({
  implement: "implementer",
  review: "reviewer",
  approval: "approver",
});

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}

function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ContractError(
      `${label} must contain exactly: ${expected.join(", ")}`,
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new ContractError(`${label} has an unknown value: ${String(value)}`);
  }
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ContractError(`${label} has an invalid value: ${String(value)}`);
  }
}

export function roleForState(state) {
  return STATE_ROLES[state] ?? null;
}

export function currentAttempt(task) {
  return task.retry.count + 1;
}

export function validateTaskMetadata(
  value,
  { idPattern = /^task-[0-9]{4,}$/ } = {},
) {
  requireExactKeys(
    value,
    [
      "schema",
      "id",
      "project",
      "title",
      "state",
      "retry",
      "approval",
      "last_review",
    ],
    "Task front matter",
  );

  if (value.schema !== "aios.task/v1") {
    throw new ContractError("Task schema must be aios.task/v1");
  }
  requirePattern(value.id, idPattern, "Task id");
  requirePattern(
    value.project,
    /^[a-z0-9][a-z0-9-]*$/,
    "Task project",
  );
  requireNonEmptyString(value.title, "Task title");
  requireEnum(value.state, TASK_STATES, "Task state");
  requireEnum(value.approval, APPROVAL_STATES, "Task approval");

  requireExactKeys(value.retry, ["count", "limit"], "Task retry");
  if (!Number.isInteger(value.retry.count) || value.retry.count < 0) {
    throw new ContractError("Task retry.count must be a non-negative integer");
  }
  if (!Number.isInteger(value.retry.limit) || value.retry.limit < 0) {
    throw new ContractError("Task retry.limit must be a non-negative integer");
  }
  if (value.retry.count > value.retry.limit) {
    throw new ContractError("Task retry.count cannot exceed retry.limit");
  }

  if (
    value.last_review !== null &&
    (typeof value.last_review !== "string" ||
      !/^review-[0-9]{4,}$/.test(value.last_review))
  ) {
    throw new ContractError("Task last_review must be null or a Review id");
  }

  if (value.state === "implement" || value.state === "review") {
    const isInitialAttempt = value.retry.count === 0;
    if (isInitialAttempt !== (value.last_review === null)) {
      throw new ContractError(
        "An implement/review Task has null last_review exactly at retry.count 0",
      );
    }
  }
  if (value.state === "approval" && value.approval !== "required") {
    throw new ContractError("An approval Task must have approval: required");
  }
  if (value.approval === "approved" && value.state !== "done") {
    throw new ContractError("approval: approved requires state: done");
  }
  if (value.approval === "rejected" && value.state !== "blocked") {
    throw new ContractError("approval: rejected requires state: blocked");
  }
  if (
    value.state === "done" &&
    value.approval !== "not_required" &&
    value.approval !== "approved"
  ) {
    throw new ContractError("A done Task must not require a pending approval");
  }

  return value;
}

export function validateReviewMetadata(value, filenameId = null) {
  requireExactKeys(
    value,
    ["schema", "id", "project", "task", "attempt", "verdict"],
    "Review front matter",
  );

  const isBootstrap = value.schema === "aios.review/v0";
  if (value.schema !== "aios.review/v1" && !isBootstrap) {
    throw new ContractError("Review schema must be aios.review/v1");
  }
  requirePattern(value.id, /^review-[0-9]{4,}$/, "Review id");
  if (filenameId !== null && value.id !== filenameId) {
    throw new ContractError("Review id must equal its filename stem");
  }
  if (isBootstrap && value.id !== "review-0001") {
    throw new ContractError("Only review-0001 may use aios.review/v0");
  }
  requirePattern(value.project, /^[a-z0-9][a-z0-9-]*$/, "Review project");
  requirePattern(value.task, /^task-[0-9]{4,}$/, "Review task");
  if (!Number.isInteger(value.attempt) || value.attempt < 1) {
    throw new ContractError("Review attempt must be an integer >= 1");
  }
  requireEnum(value.verdict, REVIEW_VERDICTS, "Review verdict");
  return value;
}

export function validateTaskReview(task, review) {
  if (review.task !== task.id || review.project !== task.project) {
    throw new ContractError("Review task/project does not match the Task");
  }

  const { count, limit } = task.retry;
  if (task.state === "implement" || task.state === "review") {
    if (count === 0) {
      throw new ContractError("An initial active Task cannot reference a Review");
    }
    if (review.verdict !== "changes_requested" || review.attempt !== count) {
      throw new ContractError("Active retry Task must reference its prior changes Review");
    }
    return;
  }

  if (task.state === "approval" || task.state === "done") {
    if (review.verdict !== "pass" || review.attempt !== count + 1) {
      throw new ContractError("Approval/done Task must reference its passing Review");
    }
    return;
  }

  if (task.state === "blocked" && task.approval === "rejected") {
    if (review.verdict !== "pass" || review.attempt !== count + 1) {
      throw new ContractError("Rejected Task must reference its passing Review");
    }
    return;
  }

  if (task.state === "blocked") {
    if (
      review.verdict !== "changes_requested" ||
      review.attempt !== count + 1 ||
      count !== limit
    ) {
      throw new ContractError("Retry-exhausted Task has invalid Review evidence");
    }
  }
}

export function validateResult(value, task, expectedRole) {
  requireExactKeys(
    value,
    ["schema", "task", "role", "status", "payload"],
    "Result",
  );
  if (value.schema !== "aios.result/v1") {
    throw new ContractError("Result schema must be aios.result/v1");
  }
  if (value.task !== task.id) {
    throw new ContractError("Result task does not match the active Task");
  }
  requireEnum(value.role, ROLES, "Result role");
  if (value.role !== expectedRole) {
    throw new ContractError("Result role does not match the active Role");
  }
  if (value.status !== "success" && value.status !== "failure") {
    throw new ContractError("Result status must be success or failure");
  }

  if (value.status === "failure") {
    const keys = Object.keys(value.payload ?? {}).sort().join(",");
    if (keys !== "reason" && keys !== "failure_kind,reason") {
      throw new ContractError(
        "Failure payload must contain reason and optional failure_kind",
      );
    }
    requireNonEmptyString(value.payload.reason, "Failure reason");
    if (
      Object.hasOwn(value.payload, "failure_kind") &&
      !RECOVERABLE_FAILURE_KINDS.has(value.payload.failure_kind)
    ) {
      throw new ContractError(
        `Failure kind has an unknown value: ${String(value.payload.failure_kind)}`,
      );
    }
    return value;
  }

  if (expectedRole === "implementer") {
    requireExactKeys(
      value.payload,
      ["summary", "verification"],
      "Implementer payload",
    );
    requireNonEmptyString(value.payload.summary, "Implementer summary");
    requireNonEmptyString(
      value.payload.verification,
      "Implementer verification",
    );
  } else if (expectedRole === "reviewer") {
    requireExactKeys(
      value.payload,
      ["verdict", "findings"],
      "Reviewer payload",
    );
    requireEnum(value.payload.verdict, REVIEW_VERDICTS, "Reviewer verdict");
    requireNonEmptyString(value.payload.findings, "Reviewer findings");
  } else {
    requireExactKeys(value.payload, ["decision"], "Approver payload");
    if (
      value.payload.decision !== "approved" &&
      value.payload.decision !== "rejected"
    ) {
      throw new ContractError("Approver decision must be approved or rejected");
    }
  }

  return value;
}
