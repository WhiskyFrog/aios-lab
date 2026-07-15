import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createImmutable,
  parseDocumentFile,
  renderDocument,
} from "../src/documents.js";

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(sourceRoot, "src", "cli.js");

async function stdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

function planDocument(planId, project) {
  return renderDocument(
    {
      schema: "aios.plan/v1",
      id: planId,
      project,
      profile: "software-feature",
      profile_reason: "The brief requests executable product behavior with integration evidence.",
    },
    `
# Cross-repository demonstration plan

## Brief

Deliver one deterministic outcome in the scratch repository.

## Profile Application

The software-feature profile keeps the proposal independently testable and integrates it through the real Task loop.

## Assumptions and Risks

The committed fixture Worker is available; no provider or network access is required.

## Decomposition Rationale

One proposal is enough to prove adoption and progression without artificial dependencies.

## Execution Order

1. P-01 delivers and verifies the scratch-repository outcome.
`,
  );
}

function proposalDocument(project) {
  return renderDocument(
    {
      schema: "aios.task/v1",
      id: "P-01",
      project,
      title: "Deliver the scratch repository outcome",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    },
    `
# Deliver the scratch repository outcome

## Objective

Complete one deterministic implementation through the real AIOS Role loop.

## Acceptance Criteria

- The fixture implementation and independent Review both succeed.

## Constraints

- Operate only in the scratch repository and use no network or paid provider.

## Context

This proposal proves an adopted Task can progress outside the AIOS source repository.

## Attempts

_None yet._
`,
  );
}

async function createPlan(task) {
  const match = /plans\/([a-z0-9][a-z0-9-]*)\//.exec(task.body);
  if (match === null) {
    return null;
  }
  const planId = match[1];
  const planDirectory = path.join(process.cwd(), "plans", planId);
  await mkdir(planDirectory, { recursive: true });
  await createImmutable(
    path.join(planDirectory, "PLAN.md"),
    planDocument(planId, task.metadata.project),
  );
  await createImmutable(
    path.join(planDirectory, "P-01.md"),
    proposalDocument(task.metadata.project),
  );
  const checked = await executeFile(
    process.execPath,
    [cli, "adopt", `plans/${planId}`, "--root", process.cwd(), "--check"],
    { cwd: process.cwd(), windowsHide: true },
  );
  const report = JSON.parse(checked.stdout);
  if (report.kind !== "checked" || report.plan !== planId) {
    throw new Error("non-mutating adopt verification returned unexpected evidence");
  }
  return planId;
}

function result(task, role, planId) {
  if (role === "reviewer") {
    return {
      schema: "aios.result/v1",
      task: task.metadata.id,
      role,
      status: "success",
      payload: {
        verdict: "pass",
        findings: "The deterministic cross-repository evidence satisfies the Task.",
      },
    };
  }
  return {
    schema: "aios.result/v1",
    task: task.metadata.id,
    role,
    status: "success",
    payload: {
      summary: planId === null
        ? "Completed the adopted scratch-repository outcome."
        : `Created and validated plans/${planId}/ in the scratch repository.`,
      verification: planId === null
        ? "The deterministic fixture completed without network or provider access."
        : `aios adopt plans/${planId} --root . --check returned checked.`,
    },
  };
}

function execution(task, role, value) {
  const now = new Date().toISOString();
  return {
    schema: "aios.worker-execution/v1",
    result: value,
    deferred: null,
    session: {
      id: `cross-repo-${task.metadata.id}-${role}`,
      task: task.metadata.id,
      role,
      model: "fixture-cross-repo",
      started_at: now,
      observed_at: now,
      outcome: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cost_usd: 0,
      capacity: null,
    },
  };
}

const raw = await stdin();
const { metadata, body } = parseDocumentFile(raw, "cross-repository fixture Task");
const task = { metadata, body };
const role = process.env.AIOS_ROLE;
if (role !== "implementer" && role !== "reviewer") {
  throw new Error(`unsupported fixture Role: ${String(role)}`);
}
const planId = role === "implementer" ? await createPlan(task) : null;
process.stdout.write(JSON.stringify(execution(task, role, result(task, role, planId))));
