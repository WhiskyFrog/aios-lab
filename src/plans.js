import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { validateTaskMetadata } from "./contracts.js";
import {
  atomicReplace,
  countAttempts,
  createImmutable,
  parseDocumentFile,
  renderDocument,
  validateTaskBody,
} from "./documents.js";

const PLAN_SCHEMA = "aios.plan/v1";
const PLAN_ID = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const PROPOSAL_ID = /^P-([0-9]{2,})$/;
const TASK_FILE = /^task-([0-9]{4,})\.md$/;

export const PLANNER_PROFILES = Object.freeze({
  "generic-goal": Object.freeze({
    decomposition: "Separate the goal into independently verifiable outcomes.",
    verification: "Define observable completion evidence for every outcome.",
  }),
  "software-feature": Object.freeze({
    decomposition: "Separate contracts, implementation, tests, and integration.",
    verification: "Require automated checks and observable feature behavior.",
  }),
  "bug-fix": Object.freeze({
    decomposition: "Separate reproduction, root cause, correction, and regression coverage.",
    verification: "Prove the original failure and the regression test both behave correctly.",
  }),
  website: Object.freeze({
    decomposition: "Separate information architecture, shared visual system, pages, and quality checks.",
    verification: "Cover content, responsive layouts, accessibility, and navigation.",
  }),
  research: Object.freeze({
    decomposition: "Separate questions, source collection, corroboration, and synthesis.",
    verification: "Require source traceability and explicit uncertainty.",
  }),
  migration: Object.freeze({
    decomposition: "Separate preflight, backup, conversion, validation, and rollback readiness.",
    verification: "Require integrity checks and a tested recovery boundary.",
  }),
  content: Object.freeze({
    decomposition: "Separate audience and purpose, outline, draft, fact-checking, and editing.",
    verification: "Require factual, structural, and editorial acceptance checks.",
  }),
});

export class PlanValidationError extends Error {
  constructor(problems) {
    super(`Plan validation failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "PlanValidationError";
    this.problems = Object.freeze([...problems]);
  }
}

export class PlanAdoptionError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "PlanAdoptionError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function markdownSection(body, heading) {
  const match = new RegExp(`^## ${heading}[ \\t]*$`, "m").exec(body);
  if (!match) {
    return null;
  }
  const remainder = body.slice(match.index + match[0].length);
  const next = /^## [^\r\n]+$/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length).trim();
}

function insideDirectPlanDirectory(root, planDirectory) {
  return path.dirname(planDirectory) === path.join(root, "plans");
}

export function validatePlanMetadata(metadata, directoryName, problems) {
  if (!exactKeys(metadata, ["schema", "id", "project", "profile", "profile_reason"])) {
    problems.push(
      "PLAN.md front matter must contain exactly: id, profile, profile_reason, project, schema",
    );
    return false;
  }
  let valid = true;
  if (metadata.schema !== PLAN_SCHEMA) {
    problems.push(`PLAN.md schema must be ${PLAN_SCHEMA}`);
    valid = false;
  }
  if (typeof metadata.id !== "string" || !PLAN_ID.test(metadata.id)) {
    problems.push("PLAN.md id must be a lowercase kebab-case identifier");
    valid = false;
  } else if (metadata.id !== directoryName) {
    problems.push("PLAN.md id must equal its plan directory name");
    valid = false;
  }
  if (typeof metadata.project !== "string" || !PROJECT_ID.test(metadata.project)) {
    problems.push("PLAN.md project must be a lowercase kebab-case identifier");
    valid = false;
  }
  if (!Object.hasOwn(PLANNER_PROFILES, metadata.profile)) {
    problems.push(
      `PLAN.md profile must be one of: ${Object.keys(PLANNER_PROFILES).join(", ")}`,
    );
    valid = false;
  }
  if (!nonEmptyString(metadata.profile_reason)) {
    problems.push("PLAN.md profile_reason must be a non-empty string");
    valid = false;
  }
  return valid;
}

export function validatePlanSections(body, problems) {
  for (const heading of [
    "Brief",
    "Profile Application",
    "Assumptions and Risks",
    "Decomposition Rationale",
    "Execution Order",
  ]) {
    if (!markdownSection(body, heading)) {
      problems.push(`PLAN.md must contain a non-empty ${heading} section`);
    }
  }
}

function validatePlanBody(body, proposalIds, problems) {
  validatePlanSections(body, problems);
  const known = new Set(proposalIds);
  const allReferences = body.match(/\bP-[0-9]{2,}\b/g) ?? [];
  for (const reference of new Set(allReferences)) {
    if (!known.has(reference)) {
      problems.push(`PLAN.md references unknown proposal ${reference}`);
    }
  }
  const execution = markdownSection(body, "Execution Order");
  if (execution === null) {
    return;
  }
  const references = execution.match(/\bP-[0-9]{2,}\b/g) ?? [];
  for (const proposalId of proposalIds) {
    const count = references.filter((reference) => reference === proposalId).length;
    if (count !== 1) {
      problems.push(
        `PLAN.md Execution Order must reference ${proposalId} exactly once (found ${String(count)})`,
      );
    }
  }
}

function validateProposal(parsed, filenameId, planMetadata, problems) {
  const label = `${filenameId}.md`;
  let metadataValid = true;
  try {
    validateTaskMetadata(parsed.metadata, { idPattern: /^P-[0-9]{2,}$/ });
  } catch (error) {
    problems.push(`${label}: ${error.message}`);
    metadataValid = false;
  }
  if (metadataValid) {
    if (parsed.metadata.id !== filenameId) {
      problems.push(`${label}: proposal id must equal its filename stem`);
    }
    if (isObject(planMetadata) && parsed.metadata.project !== planMetadata.project) {
      problems.push(`${label}: proposal project must equal PLAN.md project`);
    }
    if (parsed.metadata.state !== "implement") {
      problems.push(`${label}: proposal state must be implement`);
    }
    if (parsed.metadata.retry.count !== 0 || parsed.metadata.retry.limit !== 2) {
      problems.push(`${label}: proposal retry must be { count: 0, limit: 2 }`);
    }
    if (parsed.metadata.last_review !== null) {
      problems.push(`${label}: proposal last_review must be null`);
    }
  }
  try {
    validateTaskBody(parsed.body, filenameId);
  } catch (error) {
    problems.push(`${label}: ${error.message}`);
  }
  try {
    if (countAttempts(parsed.body) !== 0) {
      problems.push(`${label}: a proposal cannot contain Attempts`);
    }
  } catch (error) {
    problems.push(`${label}: ${error.message}`);
  }
  const references = parsed.body.match(/\bP-[0-9]{2,}\b/g) ?? [];
  if (references.some((reference) => reference !== filenameId)) {
    problems.push(`${label}: proposal bodies cannot reference other proposals`);
  }
}

function proposalNumber(id) {
  return Number(PROPOSAL_ID.exec(id)[1]);
}

export async function inspectPlan({ root, planDirectory }) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlan = path.resolve(planDirectory);
  const problems = [];
  if (!insideDirectPlanDirectory(resolvedRoot, resolvedPlan)) {
    problems.push("plan directory must be a direct child of <root>/plans");
  }

  let entries = [];
  try {
    entries = await readdir(resolvedPlan, { withFileTypes: true });
  } catch (error) {
    problems.push(`unable to read plan directory: ${error.message}`);
    return { ok: false, problems, root: resolvedRoot, planDirectory: resolvedPlan };
  }

  const entryNames = new Set(entries.map((entry) => entry.name));
  if (!entryNames.has("PLAN.md")) {
    problems.push("plan directory must contain PLAN.md");
  }
  const proposalEntries = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "PLAN.md") {
      continue;
    }
    const match = entry.isFile() ? /^(P-[0-9]{2,})\.md$/.exec(entry.name) : null;
    if (match) {
      proposalEntries.push({ entry, id: match[1] });
    } else {
      problems.push(`unexpected plan entry: ${entry.name}`);
    }
  }
  proposalEntries.sort((left, right) => proposalNumber(left.id) - proposalNumber(right.id));
  if (proposalEntries.length === 0) {
    problems.push("plan directory must contain at least one proposal");
  }
  const numericIds = proposalEntries.map(({ id }) => proposalNumber(id));
  if (numericIds.some((number) => !Number.isSafeInteger(number))) {
    problems.push("proposal numbers must be safe integers");
  }
  if (
    numericIds.some((number, index) => number !== index + 1) ||
    new Set(numericIds).size !== numericIds.length
  ) {
    problems.push("proposal filenames must form a contiguous sequence starting at P-01");
  }

  let plan = null;
  if (entryNames.has("PLAN.md")) {
    const planPath = path.join(resolvedPlan, "PLAN.md");
    try {
      const raw = await readFile(planPath, "utf8");
      const parsed = parseDocumentFile(raw, "PLAN.md");
      validatePlanMetadata(parsed.metadata, path.basename(resolvedPlan), problems);
      plan = { ...parsed, raw, path: planPath };
    } catch (error) {
      problems.push(error.message);
    }
  }

  const proposals = [];
  for (const { id } of proposalEntries) {
    const proposalPath = path.join(resolvedPlan, `${id}.md`);
    try {
      const raw = await readFile(proposalPath, "utf8");
      const parsed = parseDocumentFile(raw, `${id}.md`);
      validateProposal(parsed, id, plan?.metadata, problems);
      proposals.push({ id, ...parsed, raw, path: proposalPath });
    } catch (error) {
      problems.push(`${id}.md: ${error.message}`);
    }
  }
  if (plan !== null) {
    validatePlanBody(
      plan.body,
      proposals.map((proposal) => proposal.id),
      problems,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    root: resolvedRoot,
    planDirectory: resolvedPlan,
    plan,
    proposals,
  };
}

export function allocateTaskIds(taskFilenames, count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError("Task allocation count must be a non-negative integer");
  }
  let maximum = 0;
  for (const filename of taskFilenames) {
    const match = TASK_FILE.exec(filename);
    if (match) {
      const numericId = Number(match[1]);
      if (!Number.isSafeInteger(numericId)) {
        throw new TypeError(`Task id is too large to continue safely: ${filename}`);
      }
      maximum = Math.max(maximum, numericId);
    }
  }
  if (!Number.isSafeInteger(maximum + count)) {
    throw new TypeError("Task id allocation exceeds the safe integer range");
  }
  return Array.from({ length: count }, (_, index) =>
    `task-${String(maximum + index + 1).padStart(4, "0")}`,
  );
}

async function rollback(paths) {
  await Promise.all(paths.map((filePath) => unlink(filePath).catch(() => {})));
}

export async function adoptPlan({ root, planDirectory, checkOnly = false }) {
  const inspection = await inspectPlan({ root, planDirectory });
  if (!inspection.ok) {
    throw new PlanValidationError(inspection.problems);
  }
  const profile = inspection.plan.metadata.profile;
  if (checkOnly) {
    return {
      kind: "checked",
      plan: inspection.plan.metadata.id,
      profile,
      proposals: inspection.proposals.map((proposal) => proposal.id),
    };
  }

  const created = [];
  try {
    const tasksDirectory = path.join(inspection.root, ".aios", "tasks");
    await mkdir(tasksDirectory, { recursive: true });
    const taskEntries = await readdir(tasksDirectory, { withFileTypes: true });
    const taskIds = allocateTaskIds(
      taskEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      inspection.proposals.length,
    );
    const mapping = Object.fromEntries(
      inspection.proposals.map((proposal, index) => [proposal.id, taskIds[index]]),
    );
    const writes = inspection.proposals.map((proposal) => {
      const id = mapping[proposal.id];
      const metadata = { ...proposal.metadata, id };
      validateTaskMetadata(metadata);
      validateTaskBody(proposal.body, id);
      return {
        path: path.join(tasksDirectory, `${id}.md`),
        content: renderDocument(metadata, proposal.body),
      };
    });
    const rewrittenPlan = inspection.plan.raw.replace(
      /\bP-[0-9]{2,}\b/g,
      (placeholder) => mapping[placeholder] ?? placeholder,
    );

    if ((await readFile(inspection.plan.path, "utf8")) !== inspection.plan.raw) {
      throw new PlanAdoptionError("PLAN.md changed after validation");
    }
    for (const write of writes) {
      await createImmutable(write.path, write.content);
      created.push(write.path);
    }
    if ((await readFile(inspection.plan.path, "utf8")) !== inspection.plan.raw) {
      throw new PlanAdoptionError("PLAN.md changed during adoption");
    }
    await atomicReplace(inspection.plan.path, rewrittenPlan);
    return {
      kind: "adopted",
      plan: inspection.plan.metadata.id,
      profile,
      mapping,
    };
  } catch (error) {
    await rollback(created);
    if (error instanceof PlanAdoptionError) {
      throw error;
    }
    throw new PlanAdoptionError(`Unable to adopt plan: ${error.message}`, {
      cause: error,
    });
  }
}
