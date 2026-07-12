import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildResult,
  execArguments,
  launchCommand,
  runCodex,
  sandboxForRole,
} from "../workers/codex-worker.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexFixture = path.join(repoRoot, "fixtures", "codex-cli.js");
const codexWorker = path.join(repoRoot, "workers", "codex-worker.mjs");

test("sandboxForRole maps workspace-write to the Implementer and read-only elsewhere", () => {
  assert.equal(sandboxForRole("implementer"), "workspace-write");
  assert.equal(sandboxForRole("reviewer"), "read-only");
  assert.equal(sandboxForRole("approver"), "read-only");
  assert.equal(sandboxForRole("unknown"), null);
});

test("launchCommand prefers trailing argv tokens over AIOS_CODEX_CLI and the bare default", () => {
  assert.deepEqual(
    launchCommand(["node", "C:\\codex\\cli.js"], { AIOS_CODEX_CLI: "C:\\codex\\codex.exe" }),
    ["node", "C:\\codex\\cli.js"],
  );
  assert.deepEqual(launchCommand([], { AIOS_CODEX_CLI: "C:\\codex\\codex.exe" }), [
    "C:\\codex\\codex.exe",
  ]);
  assert.deepEqual(launchCommand([], {}), ["codex"]);
});

test("execArguments selects the sandbox per Role, includes an explicit model, and trails the prompt", () => {
  const args = execArguments("implementer", "the prompt", "C:\\tmp\\out.txt", "gpt-5-codex");

  assert.deepEqual(args, [
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--output-last-message",
    "C:\\tmp\\out.txt",
    "--model",
    "gpt-5-codex",
    "the prompt",
  ]);
  assert.equal(args.some((token) => token.startsWith("--dangerously")), false);
});

test("execArguments uses read-only for the Reviewer and omits --model when unset", () => {
  const args = execArguments("reviewer", "review this", "C:\\tmp\\out.txt", undefined);

  assert.deepEqual(args, [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-last-message",
    "C:\\tmp\\out.txt",
    "review this",
  ]);
  assert.equal(args.includes("--model"), false);
});

test("execArguments never emits a --dangerously bypass flag for any Role", () => {
  for (const role of ["implementer", "reviewer", "approver"]) {
    const args = execArguments(role, "prompt", "C:\\tmp\\out.txt", "model");
    assert.equal(args.some((token) => String(token).startsWith("--dangerously")), false);
  }
});

test("buildResult turns a well-formed reviewer reply into a success Result", () => {
  const result = buildResult(
    "task-0010",
    "reviewer",
    0,
    '{"verdict":"pass","findings":"looks good"}',
  );

  assert.deepEqual(result, {
    schema: "aios.result/v1",
    task: "task-0010",
    role: "reviewer",
    status: "success",
    payload: { verdict: "pass", findings: "looks good" },
  });
});

test("buildResult turns a failure_reason reply into a failure Result", () => {
  const result = buildResult(
    "task-0010",
    "implementer",
    0,
    '{"failure_reason":"blocked on missing credentials"}',
  );

  assert.deepEqual(result, {
    schema: "aios.result/v1",
    task: "task-0010",
    role: "implementer",
    status: "failure",
    payload: { reason: "blocked on missing credentials" },
  });
});

test("buildResult fails the adapter on a nonzero codex exec exit", () => {
  assert.throws(
    () => buildResult("task-0010", "implementer", 1, '{"summary":"a","verification":"b"}'),
    /exited with code 1/,
  );
});

test("buildResult fails the adapter when no final message was produced", () => {
  assert.throws(() => buildResult("task-0010", "implementer", 0, null), /no final message/);
});

test("buildResult fails the adapter on an unusable reply", () => {
  assert.throws(
    () => buildResult("task-0010", "approver", 0, '{"decision":"maybe"}'),
    /decision must be approved or rejected/,
  );
});

test("runCodex resolves the child exit code and writes the final message file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aios-codex-run-"));
  const outputFile = path.join(directory, "last-message.txt");
  const previousMode = process.env.CODEX_FIXTURE_MODE;
  const previousRole = process.env.AIOS_ROLE;
  process.env.CODEX_FIXTURE_MODE = "success";
  process.env.AIOS_ROLE = "reviewer";
  try {
    const exitCode = await runCodex(
      [process.execPath, codexFixture],
      execArguments("reviewer", "review this", outputFile, undefined),
    );

    assert.equal(exitCode, 0);
    const reply = buildResult(
      "task-0010",
      "reviewer",
      exitCode,
      await readFile(outputFile, "utf8"),
    );
    assert.equal(reply.status, "success");
    assert.deepEqual(reply.payload, { verdict: "pass", findings: "Codex review passes." });
  } finally {
    process.env.CODEX_FIXTURE_MODE = previousMode;
    process.env.AIOS_ROLE = previousRole;
    await rm(directory, { recursive: true, force: true });
  }
});

function runAdapter({ mode, role, taskDocument }) {
  return spawnSync(
    process.execPath,
    [codexWorker, process.execPath, codexFixture],
    {
      cwd: repoRoot,
      input: taskDocument,
      encoding: "utf8",
      env: {
        ...process.env,
        AIOS_TASK_ID: "task-0010",
        AIOS_ROLE: role,
        CODEX_FIXTURE_MODE: mode,
      },
    },
  );
}

const TASK_DOCUMENT = "---\nschema: aios.task/v1\n---\n\n## Objective\n\nExercise Codex.\n";

test("codex-worker end to end: one implementer session yields exactly one success Result", () => {
  const run = runAdapter({ mode: "success", role: "implementer", taskDocument: TASK_DOCUMENT });

  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), {
    schema: "aios.result/v1",
    task: "task-0010",
    role: "implementer",
    status: "success",
    payload: {
      summary: "Implemented through Codex.",
      verification: "Ran the suite.",
    },
  });
});

test("codex-worker end to end: a failure_reason reply becomes a failure Result on stdout", () => {
  const run = runAdapter({
    mode: "failure-reason",
    role: "reviewer",
    taskDocument: TASK_DOCUMENT,
  });

  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), {
    schema: "aios.result/v1",
    task: "task-0010",
    role: "reviewer",
    status: "failure",
    payload: { reason: "codex could not proceed" },
  });
});

test("codex-worker end to end: a nonzero codex exec exit halts with no stdout Result", () => {
  const run = runAdapter({ mode: "nonzero", role: "implementer", taskDocument: TASK_DOCUMENT });

  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /exited with code 3/);
});

test("codex-worker end to end: a missing final message file halts with no stdout Result", () => {
  const run = runAdapter({ mode: "no-output", role: "approver", taskDocument: TASK_DOCUMENT });

  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /no final message/);
});
