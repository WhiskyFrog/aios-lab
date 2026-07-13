import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument, stringify } from "yaml";

import {
  ContractError,
  currentAttempt,
  validateReviewMetadata,
  validateTaskMetadata,
  validateTaskReview,
} from "./contracts.js";

const TASK_ID = /^task-[0-9]{4,}$/;
const REVIEW_FILE = /^(review-[0-9]{4,})\.md$/;

export class StoreError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "StoreError";
  }
}

export class TaskConflictError extends StoreError {
  constructor(message = "Task changed after the Worker started") {
    super(message);
    this.name = "TaskConflictError";
  }
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function parseYaml(text, label) {
  const document = parseDocument(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new StoreError(`${label} has invalid YAML: ${document.errors[0].message}`);
  }
  return document.toJS({ maxAliasCount: 0 });
}

export function parseDocumentFile(raw, label = "Document") {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new StoreError(`${label} must contain YAML front matter`);
  }
  return {
    metadata: parseYaml(match[1], `${label} front matter`),
    body: match[2],
  };
}

export function renderDocument(metadata, body) {
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

function markdownSection(body, heading) {
  const match = new RegExp(`^## ${heading}[ \\t]*$`, "m").exec(body);
  if (!match) {
    return null;
  }
  const start = match.index + match[0].length;
  const remainder = body.slice(start);
  const nextHeading = /^## [^\r\n]+$/m.exec(remainder);
  return remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
}

export function validateTaskBody(body, taskId) {
  const objective = markdownSection(body, "Objective");
  if (!objective) {
    throw new StoreError(`Task ${taskId} must contain a non-empty Objective`);
  }
  const criteria = markdownSection(body, "Acceptance Criteria");
  if (!criteria || !/^(?:[-+*]|[0-9]+\.)[ \t]+\S/m.test(criteria)) {
    throw new StoreError(
      `Task ${taskId} must contain at least one Acceptance Criteria item`,
    );
  }
}

function legacyAttemptNumbers(attempts) {
  const numbers = [];
  const pattern =
    /^### Attempt ([0-9]+)[ \t]*\r?\n(?:[ \t]*\r?\n)+#### Summary[ \t]*$/gm;
  for (const match of attempts.matchAll(pattern)) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

function framedAttemptNumbers(attempts) {
  const startPattern =
    /<!-- aios:attempt-frame v1 number=([0-9]+) summary=([0-9]+) verification=([0-9]+) -->/g;
  const numbers = [];
  let cursor = 0;
  let firstFrame = -1;

  while (true) {
    startPattern.lastIndex = cursor;
    const match = startPattern.exec(attempts);
    if (!match) {
      break;
    }
    firstFrame = firstFrame === -1 ? match.index : firstFrame;
    const number = Number(match[1]);
    const summaryLength = Number(match[2]);
    const verificationLength = Number(match[3]);
    const prefix = `\n### Attempt ${number}\n\n#### Summary\n\n`;
    const summaryStart = match.index + match[0].length + prefix.length;
    if (attempts.slice(match.index + match[0].length, summaryStart) !== prefix) {
      throw new StoreError(`Attempt ${number} has an invalid frame prefix`);
    }
    const summaryEnd = summaryStart + summaryLength;
    const verificationPrefix = "\n\n#### Verification\n\n";
    if (
      attempts.slice(summaryEnd, summaryEnd + verificationPrefix.length) !==
      verificationPrefix
    ) {
      throw new StoreError(`Attempt ${number} has an invalid verification frame`);
    }
    const verificationStart = summaryEnd + verificationPrefix.length;
    const verificationEnd = verificationStart + verificationLength;
    const suffix = `\n<!-- /aios:attempt-frame v1 number=${number} -->`;
    if (attempts.slice(verificationEnd, verificationEnd + suffix.length) !== suffix) {
      throw new StoreError(`Attempt ${number} has an invalid frame suffix`);
    }
    numbers.push(number);
    cursor = verificationEnd + suffix.length;
  }

  return { numbers, firstFrame };
}

function attemptNumbers(body) {
  const section = markdownSection(body, "Attempts");
  if (!section) {
    return [];
  }
  // Frames locate content by offsets, so both measurement (appendAttempt)
  // and parsing must operate on the same LF-normalized view regardless of
  // how a checkout or editor materialized the document.
  const attempts = normalizeLineEndings(section);
  const framed = framedAttemptNumbers(attempts);
  if (framed.firstFrame === -1) {
    return legacyAttemptNumbers(attempts);
  }
  return [
    ...legacyAttemptNumbers(attempts.slice(0, framed.firstFrame)),
    ...framed.numbers,
  ];
}

export function countAttempts(body) {
  return attemptNumbers(body).length;
}

function validateAttemptProjection(body, metadata) {
  const numbers = attemptNumbers(body);
  const expectedCount =
    metadata.state === "implement"
      ? metadata.retry.count
      : metadata.retry.count + 1;
  if (
    numbers.length !== expectedCount ||
    numbers.some((number, index) => number !== index + 1)
  ) {
    throw new StoreError(
      `Task ${metadata.id} must contain Attempts 1 through ${expectedCount}`,
    );
  }
}

function freezeTask(task) {
  Object.freeze(task.metadata.retry);
  Object.freeze(task.metadata);
  return Object.freeze(task);
}

async function writeCompleteTemp(targetPath, content) {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.tmp-${path.basename(targetPath)}-${randomUUID()}`,
  );
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tempPath;
}

export async function atomicReplace(targetPath, content) {
  const tempPath = await writeCompleteTemp(targetPath, content);
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function createImmutable(targetPath, content) {
  const tempPath = await writeCompleteTemp(targetPath, content);
  try {
    await link(tempPath, targetPath);
  } catch (error) {
    throw new StoreError(`Refusing to overwrite immutable file ${targetPath}`, {
      cause: error,
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

export function appendAttempt(body, attempt, summary, verification) {
  if (attemptNumbers(body).includes(attempt)) {
    throw new StoreError(`Attempt ${attempt} already exists in the Task`);
  }

  const normalizedSummary = normalizeLineEndings(summary).trim();
  const normalizedVerification = normalizeLineEndings(verification).trim();
  const attemptHeading = `### Attempt ${attempt}`;
  const frame = `<!-- aios:attempt-frame v1 number=${attempt} summary=${normalizedSummary.length} verification=${normalizedVerification.length} -->`;

  const block = [
    frame,
    attemptHeading,
    "",
    "#### Summary",
    "",
    normalizedSummary,
    "",
    "#### Verification",
    "",
    normalizedVerification,
    `<!-- /aios:attempt-frame v1 number=${attempt} -->`,
  ].join("\n");

  const heading = /^## Attempts[ \t]*$/m.exec(body);
  if (!heading) {
    return `${body.trimEnd()}\n\n## Attempts\n\n${block}\n`;
  }

  const contentStart = heading.index + heading[0].length;
  const remainder = body.slice(contentStart);
  const nextHeading = /^## [^\r\n]+$/m.exec(remainder);
  const contentEnd = nextHeading
    ? contentStart + nextHeading.index
    : body.length;
  const section = body.slice(contentStart, contentEnd);
  const replacement =
    section.trim() === "" || section.trim() === "_None yet._"
      ? `\n\n${block}\n`
      : `${section.trimEnd()}\n\n${block}\n`;

  return body.slice(0, contentStart) + replacement + body.slice(contentEnd);
}

export class TaskStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.tasksDirectory = path.join(this.root, ".aios", "tasks");
    this.reviewsDirectory = path.join(this.root, ".aios", "reviews");
  }

  taskPath(taskId) {
    if (!TASK_ID.test(taskId)) {
      throw new StoreError(`Invalid Task id: ${taskId}`);
    }
    return path.join(this.tasksDirectory, `${taskId}.md`);
  }

  reviewPath(reviewId) {
    if (!/^review-[0-9]{4,}$/.test(reviewId)) {
      throw new StoreError(`Invalid Review id: ${reviewId}`);
    }
    return path.join(this.reviewsDirectory, `${reviewId}.md`);
  }

  async loadTask(taskId) {
    const filePath = this.taskPath(taskId);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      throw new StoreError(`Unable to read Task ${taskId}`, { cause: error });
    }
    const { metadata, body } = parseDocumentFile(raw, `Task ${taskId}`);
    try {
      validateTaskMetadata(metadata);
    } catch (error) {
      throw new StoreError(`Task ${taskId} is invalid: ${error.message}`, {
        cause: error,
      });
    }
    if (metadata.id !== taskId) {
      throw new StoreError(`Task id ${metadata.id} does not match ${taskId}.md`);
    }
    validateTaskBody(body, taskId);
    validateAttemptProjection(body, metadata);
    return freezeTask({ metadata, body, raw, path: filePath });
  }

  async taskIsUnchanged(task) {
    try {
      return (await readFile(task.path, "utf8")) === task.raw;
    } catch {
      return false;
    }
  }

  async writeTask(task, metadata, body = task.body) {
    if (!(await this.taskIsUnchanged(task))) {
      throw new TaskConflictError();
    }
    try {
      validateTaskMetadata(metadata);
    } catch (error) {
      if (error instanceof ContractError) {
        throw new StoreError(`Refusing to write invalid Task: ${error.message}`);
      }
      throw error;
    }
    validateTaskBody(body, metadata.id);
    validateAttemptProjection(body, metadata);
    await atomicReplace(task.path, renderDocument(metadata, body));
    return this.loadTask(metadata.id);
  }

  async loadReview(reviewId) {
    const filePath = this.reviewPath(reviewId);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      throw new StoreError(`Unable to read Review ${reviewId}`, { cause: error });
    }
    const { metadata, body } = parseDocumentFile(raw, `Review ${reviewId}`);
    try {
      validateReviewMetadata(metadata, reviewId);
    } catch (error) {
      throw new StoreError(`Review ${reviewId} is invalid: ${error.message}`, {
        cause: error,
      });
    }
    if (body.trim().length === 0) {
      throw new StoreError(`Review ${reviewId} must explain its verdict`);
    }
    return Object.freeze({ metadata: Object.freeze(metadata), body, raw, path: filePath });
  }

  async listReviews() {
    await mkdir(this.reviewsDirectory, { recursive: true });
    const entries = await readdir(this.reviewsDirectory, { withFileTypes: true });
    const reviews = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const match = REVIEW_FILE.exec(entry.name);
      if (!match) {
        continue;
      }
      reviews.push(await this.loadReview(match[1]));
    }
    return reviews;
  }

  async findReviews(taskId, attempt) {
    return (await this.listReviews()).filter(
      (review) =>
        review.metadata.task === taskId && review.metadata.attempt === attempt,
    );
  }

  async validateTaskEvidence(task) {
    const { state, last_review: lastReview } = task.metadata;
    if (lastReview === null) {
      if (state === "approval" || state === "done" || state === "blocked") {
        throw new StoreError(`Task ${task.metadata.id} is missing Review evidence`);
      }
      return null;
    }

    const review = await this.loadReview(lastReview);
    try {
      validateTaskReview(task.metadata, review.metadata);
    } catch (error) {
      throw new StoreError(
        `Task ${task.metadata.id} has invalid Review evidence: ${error.message}`,
        { cause: error },
      );
    }
    return review;
  }

  async nextReviewId() {
    let maximum = 0;
    for (const review of await this.listReviews()) {
      maximum = Math.max(maximum, Number(review.metadata.id.slice("review-".length)));
    }
    return `review-${String(maximum + 1).padStart(4, "0")}`;
  }

  async createReview(task, { verdict, findings }) {
    const attempt = currentAttempt(task.metadata);
    const existing = await this.findReviews(task.metadata.id, attempt);
    if (existing.length > 0) {
      throw new StoreError(
        `Review already exists for (${task.metadata.id}, attempt ${attempt})`,
      );
    }

    const id = await this.nextReviewId();
    const metadata = {
      schema: "aios.review/v1",
      id,
      project: task.metadata.project,
      task: task.metadata.id,
      attempt,
      verdict,
    };
    validateReviewMetadata(metadata, id);
    const body = `\n# Review of ${task.metadata.id}, Attempt ${attempt}\n\n## Findings\n\n${findings.trim()}\n`;
    await mkdir(this.reviewsDirectory, { recursive: true });
    await createImmutable(this.reviewPath(id), renderDocument(metadata, body));
    return this.loadReview(id);
  }
}
