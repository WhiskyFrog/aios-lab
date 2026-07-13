import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { atomicReplace, countAttempts, TaskStore } from "./documents.js";
import { collectPlanProposals, deriveNextActions } from "./plan-dashboard.js";
import { SessionLedger } from "./sessions.js";

const TASK_FILE = /^(task-[0-9]{4,})\.md$/;
const TASK_STATES = ["implement", "review", "approval", "done", "blocked"];

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function collectDashboardData(root) {
  const store = new TaskStore(root);
  await mkdir(store.tasksDirectory, { recursive: true });
  const entries = await readdir(store.tasksDirectory, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isFile())
    .map((entry) => TASK_FILE.exec(entry.name))
    .filter((match) => match !== null)
    .map((match) => match[1])
    .sort();

  const stateCounts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  const rows = [];
  const errors = [];
  let workerSessions = [];
  let sessionError = null;
  let project = path.basename(store.root);

  try {
    const ledger = await new SessionLedger(
      path.join(store.root, ".aios", "runtime", "sessions.json"),
    ).load();
    workerSessions = ledger.sessions;
  } catch (error) {
    sessionError = error.message;
  }

  for (const id of ids) {
    let task;
    let review = null;
    try {
      task = await store.loadTask(id);
      review = await store.validateTaskEvidence(task);
    } catch (error) {
      errors.push({ id, message: error.message });
      continue;
    }

    project = task.metadata.project;
    stateCounts[task.metadata.state] += 1;

    let awaitingApproval = false;
    let approvalFilePath = null;
    if (task.metadata.state === "approval") {
      approvalFilePath = path.join(".aios", "approvals", task.metadata.id);
      awaitingApproval = !(await pathExists(path.join(store.root, approvalFilePath)));
    }

    rows.push({
      id: task.metadata.id,
      title: task.metadata.title,
      state: task.metadata.state,
      retryCount: task.metadata.retry.count,
      retryLimit: task.metadata.retry.limit,
      approval: task.metadata.approval,
      lastReview: task.metadata.last_review,
      reviewVerdict: review?.metadata.verdict ?? null,
      reviewFindings: review?.body?.trim() ?? null,
      attemptCount: countAttempts(task.body),
      awaitingApproval,
      approvalFilePath,
    });
  }

  const { plans, errors: planErrors } = await collectPlanProposals(root);
  const nextActions = deriveNextActions({ rows, plans });

  return {
    project,
    generatedAt: new Date().toISOString(),
    stateCounts,
    rows,
    errors,
    workerSessions,
    sessionError,
    plans,
    planErrors,
    nextActions,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHeader(data) {
  return `
    <header class="page-header">
      <h1>${escapeHtml(data.project)} — AIOS Loop Dashboard</h1>
      <p class="generated">Generated ${escapeHtml(data.generatedAt)}</p>
    </header>`;
}

function renderIntro() {
  return `
    <section class="intro" aria-labelledby="intro-heading">
      <h2 id="intro-heading">What is AIOS?</h2>
      <p>
        AIOS turns a plain-language goal into working software through small,
        reviewed units of work called Tasks. Nothing merges without evidence
        that it actually works, and a human stays in control of any Task
        marked as needing a decision.
      </p>
      <h3>The Task &rarr; Review &rarr; Approval loop</h3>
      <p>Every Task moves through the same three steps:</p>
      <ol>
        <li><strong>Implement</strong> &mdash; a Worker makes the change and shows its work.</li>
        <li><strong>Review</strong> &mdash; a Reviewer checks the result against the Task's
          acceptance criteria and records a pass or a request for changes.</li>
        <li><strong>Approval</strong> &mdash; Tasks marked as requiring it wait for a human
          decision before they are considered done.</li>
      </ol>
      <p>
        A Task that fails review goes back to Implement for another attempt; a
        Task that exhausts its retry limit is marked blocked for a human to
        resolve. This page is a generated, read-only snapshot of that loop: it
        never changes anything on its own.
      </p>
    </section>`;
}

function renderCounts(data) {
  const counts = TASK_STATES.map(
    (state) =>
      `<div class="count"><span class="count-value">${data.stateCounts[state]}</span><span class="count-label badge badge-${state}">${state}</span></div>`,
  ).join("");
  return `
    <section class="counts-section" aria-labelledby="counts-heading">
      <h2 id="counts-heading">Task snapshot</h2>
      <div class="counts">${counts}</div>
    </section>`;
}

function renderReview(row) {
  if (row.lastReview === null) {
    return "";
  }
  const verdict = row.reviewVerdict ?? "unknown";
  const findings = row.reviewFindings
    ? `<details><summary>Findings</summary><p>${escapeHtml(row.reviewFindings)}</p></details>`
    : "";
  return `
      <div class="field">
        <span class="field-label">Last Review</span>
        <span class="field-value">${escapeHtml(row.lastReview)} (${escapeHtml(verdict)})</span>
      </div>
      ${findings}`;
}

function renderTaskCard(row) {
  const awaiting = row.awaitingApproval
    ? `<div class="awaiting-approval">
         Awaiting human decision. Write <code>approved</code> or
         <code>rejected</code> to
         <code>${escapeHtml(row.approvalFilePath)}</code>.
       </div>`
    : "";
  return `
    <article class="task-card">
      <div class="task-header">
        <span class="task-id">${escapeHtml(row.id)}</span>
        <span class="badge badge-${row.state}">${escapeHtml(row.state)}</span>
      </div>
      <h3 class="task-title">${escapeHtml(row.title)}</h3>
      ${awaiting}
      <div class="field">
        <span class="field-label">Retry</span>
        <span class="field-value">${row.retryCount} / ${row.retryLimit}</span>
      </div>
      <div class="field">
        <span class="field-label">Approval</span>
        <span class="field-value">${escapeHtml(row.approval)}</span>
      </div>
      <div class="field">
        <span class="field-label">Attempts</span>
        <span class="field-value">${row.attemptCount}</span>
      </div>
      ${renderReview(row)}
    </article>`;
}

function renderErrorCard(entry) {
  return `
    <article class="task-card error-card">
      <div class="task-header">
        <span class="task-id">${escapeHtml(entry.id)}</span>
        <span class="badge badge-error">error</span>
      </div>
      <p class="error-message">${escapeHtml(entry.message)}</p>
    </article>`;
}

function renderTaskSection({ id, heading, rows, emptyMessage, sectionClass }) {
  const content =
    rows.length === 0
      ? `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`
      : `<div class="grid">${rows.map(renderTaskCard).join("\n")}</div>`;
  return `
    <section class="tasks-section ${sectionClass}" aria-labelledby="${id}">
      <h2 id="${id}">${escapeHtml(heading)}</h2>
      ${content}
    </section>`;
}

function renderUpcomingTasks(data) {
  const rows = data.rows.filter((row) => row.state !== "done");
  return renderTaskSection({
    id: "upcoming-tasks-heading",
    heading: "Upcoming Tasks",
    rows,
    emptyMessage: "No upcoming Tasks. Everything currently tracked is done.",
    sectionClass: "upcoming-section",
  });
}

function renderCompletedTasks(data) {
  const rows = data.rows.filter((row) => row.state === "done");
  return renderTaskSection({
    id: "completed-tasks-heading",
    heading: "Completed Tasks",
    rows,
    emptyMessage: "No Tasks have been completed yet.",
    sectionClass: "done-section",
  });
}

function renderPlanCard(plan) {
  return `
    <article class="task-card plan-card">
      <div class="task-header">
        <span class="task-id">${escapeHtml(plan.id)}</span>
        <span class="badge badge-plan">plan</span>
      </div>
      <div class="field">
        <span class="field-label">Profile</span>
        <span class="field-value">${escapeHtml(plan.profile ?? "Not reported")}</span>
      </div>
      <div class="field">
        <span class="field-label">Proposals</span>
        <span class="field-value">${plan.proposalCount}</span>
      </div>
    </article>`;
}

function renderPlanProposals(data) {
  const pending = data.plans.filter((plan) => !plan.adopted);
  const content =
    pending.length === 0
      ? '<p class="empty-state">No plan proposals are waiting for adoption.</p>'
      : `<div class="grid">${pending.map(renderPlanCard).join("\n")}</div>`;
  return `
    <section class="plans-section" aria-labelledby="plans-heading">
      <h2 id="plans-heading">Plan proposals awaiting adoption</h2>
      ${content}
    </section>`;
}

function renderNextAction(action) {
  return `
      <li class="next-action">
        <span class="badge badge-action">${escapeHtml(action.kind)}</span>
        <span class="next-action-message">${escapeHtml(action.message)}</span>
      </li>`;
}

function renderNextActions(data) {
  const content =
    data.nextActions.length === 0
      ? '<p class="empty-state">Nothing needs action right now.</p>'
      : `<ul class="next-actions-list">${data.nextActions.map(renderNextAction).join("\n")}</ul>`;
  return `
    <section class="next-actions-section" aria-labelledby="next-actions-heading">
      <h2 id="next-actions-heading">Next actions</h2>
      ${content}
    </section>`;
}

function renderUsage(usage) {
  if (usage === null) {
    return "Not reported";
  }
  const total =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  return `${total.toLocaleString("en-US")} total (${usage.input_tokens.toLocaleString(
    "en-US",
  )} in, ${usage.output_tokens.toLocaleString("en-US")} out)`;
}

function renderSessionCard(session) {
  const capacity = session.capacity;
  const utilization =
    capacity?.utilization === null || capacity?.utilization === undefined
      ? "Not reported"
      : `${Math.round(capacity.utilization * 100)}%`;
  const refill = capacity?.resets_at ?? "Not reported";
  const cost =
    session.cost_usd === null ? "Not reported" : `$${session.cost_usd.toFixed(4)}`;
  const status = session.outcome;
  return `
    <article class="session-card">
      <div class="task-header">
        <span class="session-id">${escapeHtml(session.id)}</span>
        <span class="session-status">${escapeHtml(status)}</span>
      </div>
      <h3>${escapeHtml(session.task)} / ${escapeHtml(session.role)}</h3>
      <div class="field"><span class="field-label">Model</span><span>${escapeHtml(
        session.model ?? "Not reported",
      )}</span></div>
      <div class="field"><span class="field-label">Invocations</span><span>${session.invocations}</span></div>
      <div class="field"><span class="field-label">Tokens</span><span>${escapeHtml(
        renderUsage(session.usage),
      )}</span></div>
      <div class="field"><span class="field-label">Cost</span><span>${escapeHtml(cost)}</span></div>
      <div class="field"><span class="field-label">Capacity</span><span>${escapeHtml(
        capacity?.status ?? "Not reported",
      )}</span></div>
      <div class="field"><span class="field-label">Capacity used</span><span>${escapeHtml(
        utilization,
      )}</span></div>
      <div class="field"><span class="field-label">Refill at</span><span>${escapeHtml(
        refill,
      )}</span></div>
      <div class="field"><span class="field-label">Last observed</span><span>${escapeHtml(
        session.last_seen_at,
      )}</span></div>
    </article>`;
}

function renderWorkerSessions(data) {
  const body =
    data.workerSessions.length === 0
      ? '<p class="empty-state">No Worker sessions recorded yet.</p>'
      : `<div class="session-grid">${data.workerSessions.map(renderSessionCard).join("\n")}</div>`;
  const error = data.sessionError
    ? `<div class="session-ledger-error">Session ledger error: ${escapeHtml(
        data.sessionError,
      )}</div>`
    : "";
  return `
    <section class="sessions-section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Worker Sessions</h2>
      ${error}
      ${body}
    </section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #f4f5f7;
    color: #1c2127;
  }
  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    background: #fff;
    color: #1c2127;
    padding: 0.5rem 1rem;
    border-radius: 0 0 6px 0;
    z-index: 10;
  }
  .skip-link:focus { left: 0; }
  h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
  h2 { font-size: 1.2rem; }
  h3 { font-size: 1.05rem; }
  .page-header { margin-bottom: 1.5rem; }
  main { display: flex; flex-direction: column; gap: 2rem; }
  main > section { border-top: 1px solid #cbd1d9; padding-top: 1.5rem; }
  main > section:first-child { border-top: none; padding-top: 0; }
  .intro p, .intro li { line-height: 1.5; }
  .intro ol { padding-left: 1.25rem; }
  .generated { margin: 0 0 1rem; color: #5b6472; font-size: 0.85rem; }
  .counts { display: flex; gap: 1rem; flex-wrap: wrap; }
  .count { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; }
  .count-value { font-size: 1.5rem; font-weight: 600; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
    gap: 1rem;
  }
  .task-card {
    background: #fff;
    border: 1px solid #dde1e7;
    border-radius: 8px;
    padding: 1rem;
  }
  .task-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .task-id { font-family: monospace; color: #5b6472; }
  .task-title { margin: 0 0 0.75rem; font-size: 1.05rem; }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: #fff;
  }
  .badge-implement { background: #2f6fed; }
  .badge-review { background: #7c3fed; }
  .badge-approval { background: #b45309; }
  .badge-done { background: #15803d; }
  .badge-blocked { background: #d63939; }
  .badge-error { background: #6b7280; }
  .badge-plan { background: #46515f; }
  .badge-action { background: #2f6fed; }
  .field { display: flex; justify-content: space-between; font-size: 0.9rem; margin: 0.25rem 0; }
  .field-label { color: #5b6472; }
  .awaiting-approval {
    background: #fff3cd;
    border: 1px solid #d97706;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }
  details { margin-top: 0.5rem; font-size: 0.85rem; }
  details summary { cursor: pointer; color: #2f6fed; }
  details p { white-space: pre-wrap; margin: 0.5rem 0 0; }
  .error-card { border-color: #d63939; }
  .error-message { font-size: 0.85rem; white-space: pre-wrap; margin: 0; }
  .done-section .task-card {
    background: #f0f5f2;
    border-color: #bfd8c9;
  }
  .done-section .task-card::before {
    content: "\\2713\\0020Done";
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    color: #15803d;
    margin-bottom: 0.5rem;
  }
  .plan-card { border-color: #cfd6df; }
  .next-actions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .next-action {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: #fff;
    border: 1px solid #dde1e7;
    border-radius: 6px;
    padding: 0.6rem 0.85rem;
    font-size: 0.9rem;
  }
  .sessions-section h2 { margin: 0 0 1rem; font-size: 1.2rem; }
  .session-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
    gap: 1rem;
  }
  .session-card { background: #fff; border: 1px solid #cfd6df; border-radius: 8px; padding: 1rem; }
  .session-card h3 { margin: 0 0 0.75rem; font-size: 1rem; }
  .session-card .field { align-items: flex-start; gap: 1rem; }
  .session-card .field span:last-child { min-width: 0; text-align: right; overflow-wrap: anywhere; }
  .session-id { font-family: monospace; overflow-wrap: anywhere; color: #46515f; }
  .session-status { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
  .empty-state { color: #5b6472; }
  .session-ledger-error {
    border: 1px solid #d63939;
    background: #fff;
    color: #9b1c1c;
    padding: 0.75rem;
    margin-bottom: 1rem;
    border-radius: 6px;
  }
  @media (max-width: 480px) {
    body { padding: 1rem; }
    .counts { gap: 0.75rem; }
    .task-header { flex-wrap: wrap; row-gap: 0.35rem; }
  }
`;

function renderErrors(data) {
  const documentErrors = [
    ...data.errors.map((entry) => ({ id: entry.id, message: entry.message })),
    ...data.planErrors.map((entry) => ({ id: entry.plan, message: entry.message })),
  ];
  if (documentErrors.length === 0) {
    return "";
  }
  return `
    <section class="errors-section" aria-labelledby="errors-heading">
      <h2 id="errors-heading">Documents that failed to load</h2>
      <div class="grid">${documentErrors.map(renderErrorCard).join("\n")}</div>
    </section>`;
}

export function renderDashboard(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.project)} — AIOS Loop Dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
${renderHeader(data)}
<main id="main-content">
${renderIntro()}
${renderCounts(data)}
${renderNextActions(data)}
${renderUpcomingTasks(data)}
${renderCompletedTasks(data)}
${renderPlanProposals(data)}
${renderErrors(data)}
${renderWorkerSessions(data)}
</main>
</body>
</html>
`;
}

export async function writeDashboard({ root, out }) {
  const data = await collectDashboardData(root);
  const html = renderDashboard(data);
  const target = out ?? path.join(root, "dashboard.html");
  await mkdir(path.dirname(target), { recursive: true });
  await atomicReplace(target, html);
  return target;
}
