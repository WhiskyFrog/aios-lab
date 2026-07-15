import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { PROJECT_ID_PATTERN } from "./contracts.js";
import { TaskStore } from "./documents.js";
import { PLAN_ID_PATTERN } from "./plans.js";
import { loadExecutionConfig } from "./routing.js";

/** Maximum accepted objective size, measured as UTF-8 bytes. */
export const MAX_OBJECTIVE_BYTES = 16 * 1024;
/** Maximum character length of a plan id derived from an objective. */
export const MAX_DERIVED_PLAN_ID_LENGTH = 63;

export const TARGET_STATUSES = Object.freeze({
  NOT_DIRECTORY: "not_directory",
  NOT_REPOSITORY_ROOT: "not_repository_root",
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  CONFLICTING: "conflicting",
});

export const TARGET_ERROR_CATEGORIES = Object.freeze({
  OPERATOR_INPUT: "operator_input",
  TARGET_STATE: "target_state",
});

export class TargetContractError extends Error {
  constructor(category, message, options = undefined) {
    super(message, options);
    if (!Object.values(TARGET_ERROR_CATEGORIES).includes(category)) {
      throw new TypeError(`Unknown target contract error category: ${String(category)}`);
    }
    this.name = "TargetContractError";
    this.category = category;
    this.exitCode = category === TARGET_ERROR_CATEGORIES.OPERATOR_INPUT ? 64 : 1;
  }
}

function operatorError(message, options = undefined) {
  return new TargetContractError(
    TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
    message,
    options,
  );
}

function targetError(message, options = undefined) {
  return new TargetContractError(
    TARGET_ERROR_CATEGORIES.TARGET_STATE,
    message,
    options,
  );
}

function result(root, status, reason = null, taskProjects = []) {
  return Object.freeze({
    root,
    status,
    reason,
    taskProjects: Object.freeze([...taskProjects]),
  });
}

function pathReason(filePath, message) {
  return `${filePath}: ${message}`;
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

async function inspectTaskProjects(root, tasksDirectory) {
  let entries;
  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (error) {
    throw targetError(pathReason(tasksDirectory, error.message), { cause: error });
  }
  const store = new TaskStore(root);
  const projects = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = /^(task-[0-9]{4,})\.md$/.exec(entry.name);
    if (match === null) {
      continue;
    }
    if (!entry.isFile()) {
      throw targetError(pathReason(path.join(tasksDirectory, entry.name), "must be a file"));
    }
    let task;
    try {
      task = await store.loadTask(match[1]);
    } catch (error) {
      throw targetError(
        pathReason(path.join(tasksDirectory, entry.name), error.message),
        { cause: error },
      );
    }
    projects.push(task.metadata.project);
  }
  return projects;
}

const DIRECTORY_ENTRIES = Object.freeze([
  "tasks",
  "reviews",
  "results",
  "approvals",
  "runtime",
]);

/**
 * Read-only target classification. Missing scaffold entries are allowed so
 * `aios init` can add them; any existing standard entry must have the right
 * shape and existing Task/config documents must pass their canonical loaders.
 */
export async function inspectTarget(candidateRoot) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0) {
    throw operatorError("Target root must be a non-empty path");
  }
  const root = path.resolve(candidateRoot);
  let rootStat;
  try {
    rootStat = await optionalStat(root);
  } catch (error) {
    return result(
      root,
      TARGET_STATUSES.NOT_DIRECTORY,
      pathReason(root, `cannot be inspected: ${error.message}`),
    );
  }
  if (rootStat === null || !rootStat.isDirectory()) {
    return result(root, TARGET_STATUSES.NOT_DIRECTORY, pathReason(root, "is not a directory"));
  }

  const gitPath = path.join(root, ".git");
  let gitStat;
  try {
    gitStat = await optionalStat(gitPath);
  } catch (error) {
    return result(
      root,
      TARGET_STATUSES.NOT_REPOSITORY_ROOT,
      pathReason(gitPath, `cannot be inspected: ${error.message}`),
    );
  }
  if (gitStat === null) {
    return result(
      root,
      TARGET_STATUSES.NOT_REPOSITORY_ROOT,
      pathReason(gitPath, "is missing; bare repositories and parent repositories are not accepted"),
    );
  }
  if (!gitStat.isDirectory() && !gitStat.isFile()) {
    return result(
      root,
      TARGET_STATUSES.NOT_REPOSITORY_ROOT,
      pathReason(gitPath, "must be a directory or file directly under the target root"),
    );
  }

  const aiosPath = path.join(root, ".aios");
  let aiosStat;
  try {
    aiosStat = await optionalStat(aiosPath);
  } catch (error) {
    return result(
      root,
      TARGET_STATUSES.CONFLICTING,
      pathReason(aiosPath, `cannot be inspected: ${error.message}`),
    );
  }
  if (aiosStat === null) {
    return result(root, TARGET_STATUSES.UNINITIALIZED);
  }
  if (!aiosStat.isDirectory()) {
    return result(
      root,
      TARGET_STATUSES.CONFLICTING,
      pathReason(aiosPath, "must be a directory"),
    );
  }

  try {
    for (const name of DIRECTORY_ENTRIES) {
      const entryPath = path.join(aiosPath, name);
      const entryStat = await optionalStat(entryPath);
      if (entryStat !== null && !entryStat.isDirectory()) {
        return result(
          root,
          TARGET_STATUSES.CONFLICTING,
          pathReason(entryPath, "must be a directory"),
        );
      }
    }
    const gitignorePath = path.join(aiosPath, ".gitignore");
    const gitignoreStat = await optionalStat(gitignorePath);
    if (gitignoreStat !== null && !gitignoreStat.isFile()) {
      return result(
        root,
        TARGET_STATUSES.CONFLICTING,
        pathReason(gitignorePath, "must be a file"),
      );
    }

    const configPath = path.join(aiosPath, "assignments.json");
    const configStat = await optionalStat(configPath);
    if (configStat !== null) {
      if (!configStat.isFile()) {
        return result(
          root,
          TARGET_STATUSES.CONFLICTING,
          pathReason(configPath, "must be a file"),
        );
      }
      try {
        await loadExecutionConfig(configPath);
      } catch (error) {
        return result(
          root,
          TARGET_STATUSES.CONFLICTING,
          pathReason(configPath, error.message),
        );
      }
    }

    const tasksDirectory = path.join(aiosPath, "tasks");
    const tasksStat = await optionalStat(tasksDirectory);
    const taskProjects = tasksStat === null
      ? []
      : await inspectTaskProjects(root, tasksDirectory);
    return result(root, TARGET_STATUSES.INITIALIZED, null, taskProjects);
  } catch (error) {
    const message = error instanceof TargetContractError
      ? error.message
      : pathReason(aiosPath, `inspection failed: ${error.message}`);
    return result(root, TARGET_STATUSES.CONFLICTING, message);
  }
}

function requireUsableTarget(inspected) {
  if (
    inspected.status !== TARGET_STATUSES.UNINITIALIZED &&
    inspected.status !== TARGET_STATUSES.INITIALIZED
  ) {
    throw targetError(inspected.reason ?? `Target has state ${inspected.status}`);
  }
}

export async function resolveProjectId({ root, project = undefined }) {
  if (project !== undefined && (
    typeof project !== "string" || !PROJECT_ID_PATTERN.test(project)
  )) {
    throw operatorError(`--project has an invalid value: ${String(project)}`);
  }
  const inspected = await inspectTarget(root);
  requireUsableTarget(inspected);
  const projects = [...new Set(inspected.taskProjects)];
  if (projects.length > 1) {
    throw targetError(
      `${path.join(inspected.root, ".aios", "tasks")} contains conflicting Task project values: ${projects.join(", ")}`,
    );
  }
  if (projects.length === 1) {
    if (project !== undefined && project !== projects[0]) {
      throw operatorError(
        `--project ${project} conflicts with existing Task project ${projects[0]}`,
      );
    }
    return projects[0];
  }
  if (project !== undefined) {
    return project;
  }
  const basename = path.basename(inspected.root);
  if (PROJECT_ID_PATTERN.test(basename)) {
    return basename;
  }
  throw operatorError(
    `Target directory name ${JSON.stringify(basename)} is not a valid project id; supply --project`,
  );
}

export function validateObjective(objective) {
  if (typeof objective !== "string" || objective.trim().length === 0) {
    throw operatorError("Objective must not be empty after trimming");
  }
  const size = Buffer.byteLength(objective, "utf8");
  if (size > MAX_OBJECTIVE_BYTES) {
    throw operatorError(
      `Objective is ${size} bytes; maximum is ${MAX_OBJECTIVE_BYTES} bytes`,
    );
  }
  for (const line of objective.split(/\r\n?|\n/)) {
    if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(line)) {
      throw operatorError("Objective contains a Markdown ATX heading line");
    }
    if (/^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      throw operatorError("Objective contains a Markdown Setext heading line");
    }
    if (/^[ \t]*<!--\s*\/?aios:attempt-frame\b/i.test(line)) {
      throw operatorError("Objective contains an AIOS attempt-frame marker line");
    }
  }
  return objective;
}

export function resolvePlanId({
  objective,
  planId = undefined,
  flagName = "--plan-id",
}) {
  if (planId !== undefined) {
    if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
      throw operatorError(`${flagName} has an invalid value: ${String(planId)}`);
    }
    return planId;
  }
  const acceptedObjective = validateObjective(objective);
  const slug = acceptedObjective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_DERIVED_PLAN_ID_LENGTH)
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    throw operatorError(`Objective cannot produce a plan id; supply ${flagName}`);
  }
  return slug;
}
