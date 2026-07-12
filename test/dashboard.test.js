import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";

import { collectDashboardData, renderDashboard, writeDashboard } from "../src/dashboard.js";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");

function taskDocument(metadata, extraBody = "") {
  const body = [
    "",
    `# ${metadata.title}`,
    "",
    "## Objective",
    "",
    "Exercise the dashboard.",
    "",
    "## Acceptance Criteria",
    "",
    "- The dashboard renders this Task.",
    "",
    "## Attempts",
    "",
    extraBody || "_None yet._",
    "",
  ].join("\n");
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function reviewDocument(metadata) {
  const body = `\n# Review of ${metadata.task}, Attempt ${metadata.attempt}\n\n## Findings\n\nLooks good, findings text.\n`;
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-dashboard-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await mkdir(path.join(root, ".aios", "approvals"), { recursive: true });
  return root;
}

test("collectDashboardData reports counts, review evidence, and approval gate", async (t) => {
  const root = await makeRoot(t);

  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument({
      schema: "aios.task/v1",
      id: "task-0001",
      project: "dash-project",
      title: "Implement something",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    }),
    "utf8",
  );

  await writeFile(
    path.join(root, ".aios", "reviews", "review-0001.md"),
    reviewDocument({
      schema: "aios.review/v1",
      id: "review-0001",
      project: "dash-project",
      task: "task-0002",
      attempt: 1,
      verdict: "pass",
    }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0002.md"),
    taskDocument(
      {
        schema: "aios.task/v1",
        id: "task-0002",
        project: "dash-project",
        title: "Awaiting human approval",
        state: "approval",
        retry: { count: 0, limit: 2 },
        approval: "required",
        last_review: "review-0001",
      },
      [
        "<!-- aios:attempt-frame v1 number=1 summary=4 verification=4 -->",
        "### Attempt 1",
        "",
        "#### Summary",
        "",
        "done",
        "",
        "#### Verification",
        "",
        "done",
        "<!-- /aios:attempt-frame v1 number=1 -->",
      ].join("\n"),
    ),
    "utf8",
  );

  await writeFile(
    path.join(root, ".aios", "tasks", "task-0003.md"),
    "---\nnot: valid front matter without required keys\n---\n\nbroken\n",
    "utf8",
  );

  const data = await collectDashboardData(root);

  assert.equal(data.project, "dash-project");
  assert.equal(data.stateCounts.implement, 1);
  assert.equal(data.stateCounts.approval, 1);
  assert.equal(data.errors.length, 1);
  assert.equal(data.errors[0].id, "task-0003");
  assert.match(data.errors[0].message, /task-0003/);

  const implementRow = data.rows.find((row) => row.id === "task-0001");
  assert.equal(implementRow.attemptCount, 0);
  assert.equal(implementRow.awaitingApproval, false);

  const approvalRow = data.rows.find((row) => row.id === "task-0002");
  assert.equal(approvalRow.awaitingApproval, true);
  assert.equal(
    approvalRow.approvalFilePath,
    path.join(".aios", "approvals", "task-0002"),
  );
  assert.equal(approvalRow.reviewVerdict, "pass");
  assert.match(approvalRow.reviewFindings, /Looks good/);
  assert.equal(approvalRow.attemptCount, 1);

  await writeFile(path.join(root, ".aios", "approvals", "task-0002"), "approved", "utf8");
  const afterDecision = await collectDashboardData(root);
  const approvalRowAfter = afterDecision.rows.find((row) => row.id === "task-0002");
  assert.equal(approvalRowAfter.awaitingApproval, false);
});

test("renderDashboard produces self-contained HTML with no external requests or script tags", async (t) => {
  const root = await makeRoot(t);
  await writeFile(
    path.join(root, ".aios", "reviews", "review-0001.md"),
    reviewDocument({
      schema: "aios.review/v1",
      id: "review-0001",
      project: "dash-project",
      task: "task-0001",
      attempt: 1,
      verdict: "pass",
    }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument(
      {
        schema: "aios.task/v1",
        id: "task-0001",
        project: "dash-project",
        title: "A <Task> & \"quoted\" title",
        state: "blocked",
        retry: { count: 0, limit: 2 },
        approval: "rejected",
        last_review: "review-0001",
      },
      [
        "<!-- aios:attempt-frame v1 number=1 summary=4 verification=4 -->",
        "### Attempt 1",
        "",
        "#### Summary",
        "",
        "done",
        "",
        "#### Verification",
        "",
        "done",
        "<!-- /aios:attempt-frame v1 number=1 -->",
      ].join("\n"),
    ),
    "utf8",
  );

  const data = await collectDashboardData(root);
  const html = renderDashboard(data);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /badge-blocked/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /A &lt;Task&gt; &amp; &quot;quoted&quot; title/);
});

test("writeDashboard writes a file and returns its path", async (t) => {
  const root = await makeRoot(t);
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument({
      schema: "aios.task/v1",
      id: "task-0001",
      project: "dash-project",
      title: "Done Task",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    }),
    "utf8",
  );

  const out = path.join(root, "custom-dashboard.html");
  const written = await writeDashboard({ root, out });
  assert.equal(written, out);
  const html = await readFile(out, "utf8");
  assert.match(html, /Done Task/);
});

test("aios dashboard CLI writes dashboard.html at the repository root by default", async (t) => {
  const root = await makeRoot(t);
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument({
      schema: "aios.task/v1",
      id: "task-0001",
      project: "dash-project",
      title: "CLI-visible Task",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    }),
    "utf8",
  );

  const { stdout, stderr } = await executeFile(
    process.execPath,
    [cli, "dashboard", "--root", root],
    { cwd: root, windowsHide: true },
  );

  assert.equal(stderr, "");
  const writtenPath = stdout.trim();
  assert.equal(writtenPath, path.join(root, "dashboard.html"));
  const html = await readFile(writtenPath, "utf8");
  assert.match(html, /CLI-visible Task/);
});

test("aios --help documents both subcommands", async () => {
  const { stdout } = await executeFile(process.execPath, [cli, "--help"], {
    windowsHide: true,
  });
  assert.match(stdout, /aios run/);
  assert.match(stdout, /aios dashboard/);
});

test("aios run behavior and exit codes are unchanged by the dashboard command", async () => {
  await assert.rejects(
    executeFile(process.execPath, [cli, "run"], { windowsHide: true }),
    (error) => error.code === 64 && /Usage:/.test(error.stderr),
  );
});
