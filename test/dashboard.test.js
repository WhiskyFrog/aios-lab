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
import { SessionLedger } from "../src/sessions.js";

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

test("dashboard renders per-session usage and refill telemetry", async (t) => {
  const root = await makeRoot(t);
  const ledger = new SessionLedger(
    path.join(root, ".aios", "runtime", "sessions.json"),
  );
  await ledger.record({
    id: "session-visible-1",
    task: "task-0009",
    role: "implementer",
    model: "claude-sonnet",
    started_at: "2026-07-12T01:00:00Z",
    observed_at: "2026-07-12T01:02:00Z",
    outcome: "capacity_deferred",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 30,
    },
    cost_usd: 0.0123,
    capacity: {
      status: "rejected",
      utilization: 0.82,
      resets_at: "2026-07-12T05:00:00Z",
    },
  });

  const data = await collectDashboardData(root);
  assert.equal(data.sessionError, null);
  assert.equal(data.workerSessions.length, 1);
  const html = renderDashboard(data);
  assert.match(html, /Worker Sessions/);
  assert.match(html, /session-visible-1/);
  assert.match(html, /160 total/);
  assert.match(html, /82%/);
  assert.match(html, /2026-07-12T05:00:00\.000Z/);
});

test("dashboard shows an invalid session ledger as a visible error", async (t) => {
  const root = await makeRoot(t);
  const runtime = path.join(root, ".aios", "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "sessions.json"), "not-json", "utf8");

  const data = await collectDashboardData(root);
  assert.match(data.sessionError, /valid JSON/);
  assert.match(renderDashboard(data), /Session ledger error/);
});

function planDocument({ id, profile = "website", proposalId = "P-01", adopted = false }) {
  const executionReference = adopted ? "task-9999" : proposalId;
  return [
    "---",
    "schema: aios.plan/v1",
    `id: ${id}`,
    "project: dash-project",
    `profile: ${profile}`,
    "profile_reason: Exercise the dashboard plan-proposals section.",
    "---",
    "",
    "# Demo plan",
    "",
    "## Brief",
    "",
    "Build a small responsive website.",
    "",
    "## Execution Order",
    "",
    `1. ${executionReference} is the next outcome.`,
    "",
  ].join("\n");
}

async function makePlan(root, name, options = {}) {
  const planDirectory = path.join(root, "plans", name);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(
    path.join(planDirectory, "PLAN.md"),
    planDocument({ id: name, ...options }),
    "utf8",
  );
  await writeFile(path.join(planDirectory, "P-01.md"), "placeholder proposal", "utf8");
  return planDirectory;
}

test("renderDashboard opens with a plain-language AIOS introduction and Task/Review/Approval workflow", async (t) => {
  const root = await makeRoot(t);
  const data = await collectDashboardData(root);
  const html = renderDashboard(data);

  assert.match(html, /What is AIOS\?/);
  assert.match(html, /Task/);
  assert.match(html, /Review/);
  assert.match(html, /Approval/);
  assert.ok(
    html.indexOf("What is AIOS?") < html.indexOf("Task snapshot"),
    "intro must appear before the Task lifecycle data",
  );
});

test("renderDashboard visually separates upcoming Tasks from completed Tasks", async (t) => {
  const root = await makeRoot(t);
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument({
      schema: "aios.task/v1",
      id: "task-0001",
      project: "dash-project",
      title: "Upcoming work",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".aios", "reviews", "review-0002.md"),
    reviewDocument({
      schema: "aios.review/v1",
      id: "review-0002",
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
        title: "Finished work",
        state: "done",
        retry: { count: 0, limit: 2 },
        approval: "not_required",
        last_review: "review-0002",
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

  const upcomingSection = /<section class="tasks-section upcoming-section"[\s\S]*?<\/section>/.exec(
    html,
  )[0];
  const doneSection = /<section class="tasks-section done-section"[\s\S]*?<\/section>/.exec(
    html,
  )[0];

  assert.match(upcomingSection, /Upcoming Tasks/);
  assert.match(upcomingSection, /task-0001/);
  assert.doesNotMatch(upcomingSection, /task-0002/);

  assert.match(doneSection, /Completed Tasks/);
  assert.match(doneSection, /task-0002/);
  assert.doesNotMatch(doneSection, /task-0001/);
});

test("renderDashboard lists not-yet-adopted plan proposals separately from adopted ones", async (t) => {
  const root = await makeRoot(t);
  await makePlan(root, "pending-plan", { profile: "website", adopted: false });
  await makePlan(root, "adopted-plan", { profile: "bug-fix", adopted: true });

  const data = await collectDashboardData(root);
  const html = renderDashboard(data);

  const plansSection = /<section class="plans-section"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(plansSection, /Plan proposals awaiting adoption/);
  assert.match(plansSection, /pending-plan/);
  assert.match(plansSection, /website/);
  assert.match(plansSection, />1</);
  assert.doesNotMatch(plansSection, /adopted-plan/);
});

test("renderDashboard shows an empty state when no plan proposals are pending", async (t) => {
  const root = await makeRoot(t);
  const data = await collectDashboardData(root);
  const html = renderDashboard(data);

  assert.match(html, /No plan proposals are waiting for adoption\./);
});

test("renderDashboard shows an unparsable PLAN.md as a visible named error, not an aborted page", async (t) => {
  const root = await makeRoot(t);
  const brokenDirectory = path.join(root, "plans", "broken-plan");
  await mkdir(brokenDirectory, { recursive: true });
  await writeFile(path.join(brokenDirectory, "PLAN.md"), "not a document at all", "utf8");
  await writeFile(path.join(brokenDirectory, "P-01.md"), "placeholder", "utf8");

  const data = await collectDashboardData(root);
  assert.equal(data.planErrors.length, 1);
  const html = renderDashboard(data);

  assert.match(html, /Documents that failed to load/);
  assert.match(html, /broken-plan/);
});

test("renderDashboard lists plain-language next actions, or an explicit empty state", async (t) => {
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
        title: "Awaiting a human decision",
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

  const withAction = await collectDashboardData(root);
  const htmlWithAction = renderDashboard(withAction);
  assert.match(htmlWithAction, /Next actions/);
  assert.match(htmlWithAction, /Approve or reject task-0001/);

  await rm(path.join(root, ".aios", "tasks", "task-0001.md"));
  const withoutAction = await collectDashboardData(root);
  const htmlWithoutAction = renderDashboard(withoutAction);
  assert.match(htmlWithoutAction, /Nothing needs action right now\./);
});

test("renderDashboard uses a single h1 and gives every landmark section an accessible heading", async (t) => {
  const root = await makeRoot(t);
  await makePlan(root, "pending-plan", { profile: "website", adopted: false });
  await writeFile(
    path.join(root, ".aios", "tasks", "task-0001.md"),
    taskDocument({
      schema: "aios.task/v1",
      id: "task-0001",
      project: "dash-project",
      title: "Upcoming work",
      state: "implement",
      retry: { count: 0, limit: 2 },
      approval: "not_required",
      last_review: null,
    }),
    "utf8",
  );

  const data = await collectDashboardData(root);
  const html = renderDashboard(data);

  const h1Count = (html.match(/<h1[ >]/g) ?? []).length;
  assert.equal(h1Count, 1, "the page must have exactly one top-level heading");

  assert.match(html, /<main id="main-content">/);

  const headingIds = new Set((html.match(/<h[1-6] id="([^"]+)"/g) ?? []).map((tag) => tag.match(/id="([^"]+)"/)[1]));
  const labelledSections = html.match(/<section[^>]*aria-labelledby="([^"]+)"/g) ?? [];
  assert.ok(labelledSections.length >= 5, "every content section should be a labelled landmark");
  for (const section of labelledSections) {
    const referencedId = section.match(/aria-labelledby="([^"]+)"/)[1];
    assert.ok(
      headingIds.has(referencedId),
      `section aria-labelledby="${referencedId}" must reference a real heading id`,
    );
  }
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
