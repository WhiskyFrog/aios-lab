import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { atomicReplace, countAttempts, TaskStore } from "./documents.js";
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

  return {
    project,
    generatedAt: new Date().toISOString(),
    stateCounts,
    rows,
    errors,
    workerSessions,
    sessionError,
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

function renderOverview(data) {
  const counts = TASK_STATES.map(
    (state) =>
      `<div class="count"><span class="count-value">${data.stateCounts[state]}</span><span class="count-label badge badge-${state}">${state}</span></div>`,
  ).join("");
  return `
    <header class="overview">
      <h1>${escapeHtml(data.project)} — Loop Dashboard</h1>
      <p class="generated">Generated ${escapeHtml(data.generatedAt)}</p>
      <div class="counts">${counts}</div>
    </header>`;
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
      <h2 class="task-title">${escapeHtml(row.title)}</h2>
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
    <section class="sessions-section">
      <h2>Worker Sessions</h2>
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
  h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
  .generated { margin: 0 0 1rem; color: #5b6472; font-size: 0.85rem; }
  .counts { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
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
  .badge-approval { background: #d97706; }
  .badge-done { background: #1a9e5c; }
  .badge-blocked { background: #d63939; }
  .badge-error { background: #6b7280; }
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
  .errors-section { margin-top: 2rem; }
  .sessions-section { margin-top: 2rem; border-top: 1px solid #cbd1d9; padding-top: 1.5rem; }
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
`;

export function renderDashboard(data) {
  const cards = data.rows.map(renderTaskCard).join("\n");
  const errorCards =
    data.errors.length > 0
      ? `<section class="errors-section"><h2>Documents that failed to load</h2><div class="grid">${data.errors
          .map(renderErrorCard)
          .join("\n")}</div></section>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(data.project)} — Loop Dashboard</title>
<style>${STYLE}</style>
</head>
<body>
${renderOverview(data)}
<main class="grid">
${cards}
</main>
${renderWorkerSessions(data)}
${errorCards}
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
