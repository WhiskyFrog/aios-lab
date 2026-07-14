import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { roleForState } from "./contracts.js";
import { parseDocumentFile } from "./documents.js";
import { derivePlanProgressState, STOP_REASONS } from "./progression.js";

const PROPOSAL_FILE = /^P-[0-9]{2,}\.md$/;
const PLACEHOLDER_REFERENCE = /\bP-[0-9]{2,}\b/;

export async function collectPlanProposals(root) {
  const plansDirectory = path.join(path.resolve(root), "plans");
  let entries;
  try {
    entries = await readdir(plansDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { plans: [], errors: [] };
    }
    throw error;
  }

  const plans = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const planDirectory = path.join(plansDirectory, entry.name);

    let planEntries;
    try {
      planEntries = await readdir(planDirectory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        plan: entry.name,
        message: `unable to read plan directory: ${error.message}`,
      });
      continue;
    }
    const proposalCount = planEntries.filter(
      (planEntry) => planEntry.isFile() && PROPOSAL_FILE.test(planEntry.name),
    ).length;

    let metadata;
    let body;
    try {
      const raw = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
      ({ metadata, body } = parseDocumentFile(raw, "PLAN.md"));
    } catch (error) {
      errors.push({ plan: entry.name, message: error.message });
      continue;
    }

    plans.push({
      id: typeof metadata?.id === "string" ? metadata.id : entry.name,
      directory: entry.name,
      profile: metadata?.profile ?? null,
      proposalCount,
      adopted: !PLACEHOLDER_REFERENCE.test(body),
    });
  }

  return { plans, errors };
}

function latestObservedSession(sessions, taskId, role) {
  const latest =
    sessions
      .filter((session) => session.task === taskId && session.role === role)
      .sort(
        (left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at),
      )[0] ?? null;
  return latest?.outcome === "failed" || latest?.outcome === "capacity_deferred"
    ? latest
    : null;
}

export async function collectPlanProgress({ root, plans, store, sessions = [] }) {
  const progress = [];
  for (const plan of plans.filter((entry) => entry.adopted)) {
    const state = await derivePlanProgressState({
      root,
      planDirectory: path.join(path.resolve(root), "plans", plan.directory),
      store,
    });
    const durableCategory =
      state.stopReason === STOP_REASONS.AWAITING_APPROVAL ||
      state.stopReason === STOP_REASONS.BLOCKED_REJECTED ||
      state.stopReason === STOP_REASONS.BLOCKED_RETRY_EXHAUSTED ||
      state.stopReason === STOP_REASONS.INVALID_DOCUMENT
        ? state.stopReason
        : null;
    const observed =
      durableCategory === null && state.task !== null
        ? latestObservedSession(sessions, state.task, roleForState(state.taskState))
        : null;
    progress.push({
      id: state.plan,
      order: state.order,
      completed: state.completed,
      currentTask: state.task,
      currentTaskState: state.taskState,
      complete: state.stopReason === STOP_REASONS.PLAN_COMPLETE,
      currentCategory: durableCategory,
      action: durableCategory === null ? null : state.action,
      lastObserved:
        observed === null
          ? null
          : {
              role: observed.role,
              outcome: observed.outcome,
              observedAt: observed.last_seen_at,
            },
    });
  }
  return progress;
}

export function deriveNextActions({ rows = [], plans = [] } = {}) {
  const actions = [];
  for (const row of rows) {
    if (row.state === "approval" && row.awaitingApproval) {
      actions.push({
        kind: "approval",
        id: row.id,
        message: `Approve or reject ${row.id}`,
      });
    } else if (row.state === "blocked") {
      actions.push({
        kind: "blocked",
        id: row.id,
        message: `Unblock ${row.id}`,
      });
    }
  }
  for (const plan of plans) {
    if (!plan.adopted) {
      actions.push({
        kind: "plan-adoption",
        id: plan.id,
        message: `Adopt plan ${plan.id}`,
      });
    }
  }
  return actions;
}
