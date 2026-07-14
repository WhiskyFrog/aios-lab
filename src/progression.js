import path from "node:path";
import { readFile } from "node:fs/promises";

import { parseDocumentFile } from "./documents.js";
import { markdownSection } from "./plans.js";

const TASK_ID = /\btask-[0-9]{4,}\b/g;
const PLACEHOLDER_ID = /\bP-[0-9]{2,}\b/;

export const STOP_REASONS = Object.freeze({
  PLAN_COMPLETE: "plan_complete",
  AWAITING_APPROVAL: "awaiting_approval",
  BLOCKED_REJECTED: "blocked_rejected",
  BLOCKED_RETRY_EXHAUSTED: "blocked_retry_exhausted",
  WORKER_FAILURE: "worker_failure",
  INVALID_DOCUMENT: "invalid_document",
  CAPACITY_WAIT: "capacity_wait",
  CANCELLED: "cancelled",
  CONFLICT: "conflict",
});

export class PlanOrderError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanOrderError";
  }
}

function approvalFilePath(root, taskId) {
  return path.join(root, ".aios", "approvals", taskId);
}

// Reads an already-adopted plan's PLAN.md and returns the ordered, deduplicated
// list of real Task ids in its Execution Order section, reusing the same
// document-parsing and section-extraction helpers plans.js already uses to
// validate that section at adoption time.
export async function readPlanOrder({ root, planDirectory, store }) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlan = path.resolve(planDirectory);
  const planPath = path.join(resolvedPlan, "PLAN.md");

  let raw;
  try {
    raw = await readFile(planPath, "utf8");
  } catch (error) {
    throw new PlanOrderError(`Unable to read ${planPath}: ${error.message}`);
  }

  const { metadata, body } = parseDocumentFile(raw, "PLAN.md");
  if (typeof metadata.project !== "string" || metadata.project.trim().length === 0) {
    throw new PlanOrderError("PLAN.md must declare a project");
  }
  if (PLACEHOLDER_ID.test(raw)) {
    throw new PlanOrderError(
      "PLAN.md still contains an unadopted P-## placeholder; adopt the plan before progressing it",
    );
  }

  const section = markdownSection(body, "Execution Order");
  if (section === null) {
    throw new PlanOrderError("PLAN.md must contain a non-empty Execution Order section");
  }

  const order = [...new Set([...section.matchAll(TASK_ID)].map((match) => match[0]))];
  if (order.length === 0) {
    throw new PlanOrderError(
      "PLAN.md Execution Order does not reference any adopted Task id",
    );
  }

  const problems = [];
  for (const taskId of order) {
    let task;
    try {
      task = await store.loadTask(taskId);
    } catch (error) {
      problems.push(`${taskId}: ${error.message}`);
      continue;
    }
    if (task.metadata.project !== metadata.project) {
      problems.push(
        `${taskId}: Task project "${task.metadata.project}" does not match plan project "${metadata.project}"`,
      );
    }
  }
  if (problems.length > 0) {
    throw new PlanOrderError(
      `Plan order validation failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }

  return { root: resolvedRoot, planDirectory: resolvedPlan, plan: metadata.id, order };
}

// Selects the next unfinished Task from an order: every Task from the start
// that is already done is completed and skipped; the first non-done Task is
// next. If every Task is done, next is null and completed is the full order.
export async function selectNextTask({ store, order }) {
  const completed = [];
  for (const taskId of order) {
    const task = await store.loadTask(taskId);
    if (task.metadata.state !== "done") {
      return { completed, next: taskId };
    }
    completed.push(taskId);
  }
  return { completed, next: null };
}

function stopFor(root, plan, completed, taskId, outcome) {
  if (outcome.kind === "blocked") {
    const rejected = outcome.task.metadata.approval === "rejected";
    return {
      plan,
      task: taskId,
      completed,
      stopReason: rejected ? STOP_REASONS.BLOCKED_REJECTED : STOP_REASONS.BLOCKED_RETRY_EXHAUSTED,
      action: rejected
        ? `Task ${taskId} was rejected during approval; revise it with a fresh Attempt, then rerun progression.`
        : `Task ${taskId} exhausted its retry limit; a human must intervene on it, then rerun progression.`,
    };
  }

  if (outcome.kind === "waiting") {
    return {
      plan,
      task: taskId,
      completed,
      stopReason: STOP_REASONS.CAPACITY_WAIT,
      action: `Worker capacity is unavailable until ${outcome.retryAt}; rerun progression at or after that time.`,
    };
  }

  if (outcome.category === "approval_gate") {
    return {
      plan,
      task: taskId,
      completed,
      stopReason: STOP_REASONS.AWAITING_APPROVAL,
      action:
        `Create ${approvalFilePath(root, taskId)} containing exactly ` +
        `"approved" or "rejected", then rerun progression.`,
    };
  }

  if (outcome.category === "conflict") {
    return {
      plan,
      task: taskId,
      completed,
      stopReason: STOP_REASONS.CONFLICT,
      action: `Task ${taskId} changed underneath the engine; confirm its current state, then rerun progression.`,
    };
  }

  if (outcome.category === "cancelled") {
    return {
      plan,
      task: taskId,
      completed,
      stopReason: STOP_REASONS.CANCELLED,
      action: `The run was cancelled before Task ${taskId} finished; rerun progression to continue.`,
    };
  }

  if (outcome.category === "invalid_document") {
    return {
      plan,
      task: taskId,
      completed,
      stopReason: STOP_REASONS.INVALID_DOCUMENT,
      action: `Fix the invalid document (${outcome.reason}), then rerun progression.`,
    };
  }

  return {
    plan,
    task: taskId,
    completed,
    stopReason: STOP_REASONS.WORKER_FAILURE,
    action: `Investigate the Worker failure (${outcome.reason}) for Task ${taskId}, then rerun progression.`,
  };
}

// Scans forward from `startIndex` over `order`, appending each already-done
// Task to `completed` and advancing past it, stopping at the first Task that
// is not done (or at the end of the order). Never moves the cursor backward
// and never inspects a Task more than once per call.
async function skipDoneSuffix(store, order, startIndex, completed) {
  let index = startIndex;
  while (index < order.length) {
    const task = await store.loadTask(order[index]);
    if (task.metadata.state !== "done") {
      return index;
    }
    completed.push(order[index]);
    index += 1;
  }
  return index;
}

// Advances a plan across potentially many Tasks in one call: repeatedly
// selects the next unfinished Task and invokes engine.run on it exactly once,
// continuing while the outcome is "done" and stopping on any other outcome.
export async function runProgression({ root, planDirectory, engine, runOptions = {} }) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlan = path.resolve(planDirectory);
  const plan = path.basename(resolvedPlan);

  let order;
  try {
    ({ order } = await readPlanOrder({
      root: resolvedRoot,
      planDirectory: resolvedPlan,
      store: engine.store,
    }));
  } catch (error) {
    return {
      plan,
      task: null,
      completed: [],
      stopReason: STOP_REASONS.INVALID_DOCUMENT,
      action: `Fix PLAN.md before running progression: ${error.message}`,
    };
  }

  let selection;
  try {
    selection = await selectNextTask({ store: engine.store, order });
  } catch (error) {
    return {
      plan,
      task: null,
      completed: [],
      stopReason: STOP_REASONS.INVALID_DOCUMENT,
      action: `Fix the Task referenced by the plan before running progression: ${error.message}`,
    };
  }

  if (selection.next === null) {
    return {
      plan,
      task: null,
      completed: selection.completed,
      stopReason: STOP_REASONS.PLAN_COMPLETE,
      action: "No action needed: every Task in the plan is done.",
    };
  }

  // Once resumed past the already-done prefix above, this call tracks its own
  // completed/invoked Tasks by walking `order` strictly forward instead of
  // rescanning repository state, so a Task is never passed to engine.run more
  // than once even if "done" is not immediately reflected in the Task store.
  //
  // The order can still contain an already-done Task *after* the resume
  // point (for example [unfinished, already-done, unfinished]), so after
  // each "done" outcome the remaining suffix must be rescanned for further
  // already-done Tasks before invoking the engine again - advancing the
  // index blindly would pass an already-done Task straight to engine.run.
  const completed = [...selection.completed];
  let index = order.indexOf(selection.next);

  while (index < order.length) {
    const taskId = order[index];
    const outcome = await engine.run(taskId, runOptions);
    if (outcome.kind === "done") {
      completed.push(taskId);
      index = await skipDoneSuffix(engine.store, order, index + 1, completed);
      continue;
    }

    return stopFor(resolvedRoot, plan, completed, taskId, outcome);
  }

  return {
    plan,
    task: null,
    completed,
    stopReason: STOP_REASONS.PLAN_COMPLETE,
    action: "No action needed: every Task in the plan is done.",
  };
}
