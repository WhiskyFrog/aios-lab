import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { validateTaskMetadata } from "./contracts.js";
import {
  createImmutable,
  renderDocument,
  validateTaskBody,
} from "./documents.js";
import {
  allocateTaskIds,
  PLANNER_PROFILES,
} from "./plans.js";
import {
  inspectTarget,
  resolvePlanId,
  resolveProjectId,
  TARGET_ERROR_CATEGORIES,
  TARGET_STATUSES,
  TargetContractError,
  validateObjective,
} from "./targets.js";

export const MAX_BRIEF_TITLE_LENGTH = 80;

function stateError(message, options = undefined) {
  return new TargetContractError(
    TARGET_ERROR_CATEGORIES.TARGET_STATE,
    message,
    options,
  );
}

async function optionalStat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function deriveTitle(objective) {
  const singleLine = objective.trim().replace(/\s+/g, " ");
  const characters = Array.from(singleLine);
  if (characters.length <= MAX_BRIEF_TITLE_LENGTH) {
    return singleLine;
  }
  return characters.slice(0, MAX_BRIEF_TITLE_LENGTH).join("").trimEnd();
}

function profileTable() {
  return Object.entries(PLANNER_PROFILES)
    .map(([id, profile]) =>
      `- \`${id}\`: ${profile.decomposition} ${profile.verification}`,
    )
    .join("\n");
}

export function renderPlanningTask({ id, project, planId, objective }) {
  const metadata = {
    schema: "aios.task/v1",
    id,
    project,
    title: deriveTitle(objective),
    state: "implement",
    retry: { count: 0, limit: 2 },
    approval: "required",
    last_review: null,
  };
  const body = `
# Plan ${planId}

## Objective

Produce a reviewed plan under \`plans/${planId}/\` in this repository for the Brief below. Follow the existing AIOS Planner protocol, preserve the Brief, choose the narrowest applicable registered profile, and keep execution order only in the plan document.

## Brief

${objective}

## Planner Profiles

${profileTable()}

## Acceptance Criteria

- \`plans/${planId}/PLAN.md\` has valid \`aios.plan/v1\` front matter with a registered profile and a non-empty \`profile_reason\`.
- \`PLAN.md\` contains non-empty Brief, Profile Application, Assumptions and Risks, Decomposition Rationale, and Execution Order sections.
- Proposal files are contiguous valid Task documents using \`P-01\`, \`P-02\`, and so on, with relationships and ordering stated only in \`PLAN.md\`.
- Implementer Verification records a passing, non-mutating \`aios adopt plans/${planId} --root . --check\` run.

## Constraints

- Write only under \`plans/${planId}/\`.
- Do not modify \`.aios/\`, existing Tasks, Reviews, configuration, or ledgers.
- Do not dispatch another Worker or spend provider capacity from the plan.
- Proposals become Tasks only through a separate operator-invoked \`aios adopt\` command.
- Do not include provider/model requirements, credentials, secrets, or user-local paths.

## Context

The Planner proposes independently verifiable, one-session outcomes. Review checks both mechanical plan validity and decomposition quality; adoption remains an explicit operator action.

## Attempts

_None yet._
`;
  validateTaskMetadata(metadata);
  validateTaskBody(body, id);
  return Object.freeze({
    metadata: Object.freeze({ ...metadata, retry: Object.freeze(metadata.retry) }),
    body,
    content: renderDocument(metadata, body),
  });
}

export async function createPlanningTaskFile(taskPath, content) {
  try {
    await createImmutable(taskPath, content);
  } catch (error) {
    throw stateError(`Unable to create ${taskPath}: ${error.message}`, { cause: error });
  }
}

export async function createBrief({
  root,
  objective,
  planId = undefined,
  project = undefined,
  checkOnly = false,
}) {
  const inspected = await inspectTarget(root);
  if (inspected.status === TARGET_STATUSES.UNINITIALIZED) {
    throw stateError(`${inspected.root} is not initialized; run aios init --root ${JSON.stringify(inspected.root)} first`);
  }
  if (inspected.status !== TARGET_STATUSES.INITIALIZED) {
    throw stateError(inspected.reason ?? `Target has state ${inspected.status}`);
  }

  const acceptedObjective = validateObjective(objective);
  const resolvedProject = await resolveProjectId({ root: inspected.root, project });
  const resolvedPlan = resolvePlanId({
    objective: acceptedObjective,
    planId,
    flagName: "--plan",
  });

  const tasksDirectory = path.join(inspected.root, ".aios", "tasks");
  const tasksStat = await optionalStat(tasksDirectory);
  if (tasksStat === null || !tasksStat.isDirectory()) {
    throw stateError(`${tasksDirectory} is missing; run aios init --root ${JSON.stringify(inspected.root)} first`);
  }
  const plansDirectory = path.join(inspected.root, "plans");
  const plansStat = await optionalStat(plansDirectory);
  if (plansStat !== null && !plansStat.isDirectory()) {
    throw stateError(`${plansDirectory}: must be a directory`);
  }
  const planDirectory = path.join(plansDirectory, resolvedPlan);
  if (await optionalStat(planDirectory) !== null) {
    throw stateError(`${planDirectory}: plan already exists`);
  }

  let entries;
  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (error) {
    throw stateError(`${tasksDirectory}: cannot be read: ${error.message}`, { cause: error });
  }
  const [taskId] = allocateTaskIds(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    1,
  );
  const taskPath = path.join(tasksDirectory, `${taskId}.md`);
  if (await optionalStat(taskPath) !== null) {
    throw stateError(`${taskPath}: Task id collision`);
  }
  const task = renderPlanningTask({
    id: taskId,
    project: resolvedProject,
    planId: resolvedPlan,
    objective: acceptedObjective,
  });
  const report = Object.freeze({
    kind: checkOnly ? "checked" : "created",
    task: taskId,
    plan: resolvedPlan,
    project: resolvedProject,
  });
  if (checkOnly) {
    return report;
  }
  await createPlanningTaskFile(taskPath, task.content);
  return report;
}
