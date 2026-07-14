import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createImmutable } from "./documents.js";
import { parseExecutionConfig } from "./routing.js";
import {
  inspectTarget,
  TARGET_ERROR_CATEGORIES,
  TARGET_STATUSES,
  TargetContractError,
} from "./targets.js";

export const AIOS_GITIGNORE = "runtime/\nassignments.json\n";
export const AIOS_SCAFFOLD_DIRECTORIES = Object.freeze([
  ".aios",
  ".aios/tasks",
  ".aios/reviews",
  ".aios/results",
  ".aios/approvals",
  ".aios/runtime",
]);

function inputError(message, options = undefined) {
  return new TargetContractError(
    TARGET_ERROR_CATEGORIES.OPERATOR_INPUT,
    message,
    options,
  );
}

function stateError(message, options = undefined) {
  return new TargetContractError(
    TARGET_ERROR_CATEGORIES.TARGET_STATE,
    message,
    options,
  );
}

async function existingStat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function commandEntries(execution) {
  if (execution.kind === "assignments") {
    return Object.entries(execution.config.assignments).map(([role, command]) => ({
      label: `Role ${role}`,
      command,
    }));
  }
  return execution.config.candidates.map((candidate) => ({
    label: `candidate ${candidate.id} (Roles ${candidate.roles.join(", ")})`,
    command: candidate.command,
  }));
}

export async function validateAdapterPaths(execution, root) {
  for (const { label, command } of commandEntries(execution)) {
    for (const token of command) {
      if (!/[\\/]/.test(token)) {
        continue;
      }
      const absolute = path.isAbsolute(token);
      const resolved = absolute ? path.resolve(token) : path.resolve(root, token);
      if (!absolute && !insideRoot(root, resolved)) {
        throw inputError(
          `--from ${label} token ${JSON.stringify(token)} escapes target root ${root}`,
        );
      }
      let stat;
      try {
        stat = await existingStat(resolved);
      } catch (error) {
        throw inputError(
          `--from ${label} token ${JSON.stringify(token)} cannot be inspected: ${error.message}`,
          { cause: error },
        );
      }
      if (stat === null || (!absolute && !stat.isFile())) {
        const requirement = absolute ? "exist" : "resolve to an existing file";
        throw inputError(
          `--from ${label} token ${JSON.stringify(token)} must ${requirement} (${resolved})`,
        );
      }
    }
  }
}

async function loadSource(sourcePath, root) {
  let raw;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw inputError(`Unable to read --from configuration ${sourcePath}: ${error.message}`, {
      cause: error,
    });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw inputError(`--from configuration ${sourcePath} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  let execution;
  try {
    execution = parseExecutionConfig(value);
  } catch (error) {
    throw inputError(`--from configuration ${sourcePath} is invalid: ${error.message}`, {
      cause: error,
    });
  }
  await validateAdapterPaths(execution, root);
  return Object.freeze({ raw, execution });
}

function relativeActionPath(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function planEntry(root, relativePath, type, content = null) {
  const target = path.join(root, ...relativePath.split("/"));
  let stat;
  try {
    stat = await existingStat(target);
  } catch (error) {
    throw stateError(`${target}: cannot be inspected: ${error.message}`, { cause: error });
  }
  if (stat !== null) {
    const correct = type === "directory" ? stat.isDirectory() : stat.isFile();
    if (!correct) {
      throw stateError(`${target}: must be a ${type}`);
    }
  }
  return { target, path: relativeActionPath(root, target), type, content, exists: stat !== null };
}

async function createEntry(entry) {
  try {
    if (entry.type === "directory") {
      await mkdir(entry.target);
    } else {
      await createImmutable(entry.target, entry.content);
    }
  } catch (error) {
    throw stateError(`Unable to create ${entry.target}: ${error.message}`, { cause: error });
  }
}

export async function initializeRepository({ root, from = undefined, checkOnly = false }) {
  const inspected = await inspectTarget(root);
  if (
    inspected.status !== TARGET_STATUSES.UNINITIALIZED &&
    inspected.status !== TARGET_STATUSES.INITIALIZED
  ) {
    throw stateError(inspected.reason ?? `Target has state ${inspected.status}`);
  }

  const sourcePath = from === undefined ? null : path.resolve(from);
  const source = sourcePath === null ? null : await loadSource(sourcePath, inspected.root);

  // Build and validate the complete action plan before the first write.
  const entries = [];
  for (const directory of AIOS_SCAFFOLD_DIRECTORIES) {
    entries.push(await planEntry(inspected.root, directory, "directory"));
  }
  entries.push(await planEntry(
    inspected.root,
    ".aios/.gitignore",
    "file",
    AIOS_GITIGNORE,
  ));
  const configEntry = await planEntry(
    inspected.root,
    ".aios/assignments.json",
    "file",
    source?.raw ?? null,
  );
  if (configEntry.exists || source !== null) {
    entries.push(configEntry);
  }

  const actions = [];
  for (const entry of entries) {
    if (entry.exists) {
      actions.push(Object.freeze({ path: entry.path, action: "already_present" }));
      continue;
    }
    if (checkOnly) {
      actions.push(Object.freeze({ path: entry.path, action: "would_create" }));
      continue;
    }
    await createEntry(entry);
    actions.push(Object.freeze({ path: entry.path, action: "created" }));
  }
  return Object.freeze({
    kind: checkOnly ? "checked" : "initialized",
    root: inspected.root,
    actions: Object.freeze(actions),
  });
}
