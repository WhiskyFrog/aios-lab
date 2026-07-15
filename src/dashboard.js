import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { atomicReplace, countAttempts, TaskStore } from "./documents.js";
import {
  collectPlanProgress,
  collectPlanProposals,
  deriveNextActions,
} from "./plan-dashboard.js";
import { RoutingDecisionLedger, routingDecisionsPath } from "./routing-ledger.js";
import { OVERRIDE_DISPLACEABLE_REASON_CODES } from "./routing-policy.js";
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

  // Routing decisions load through the ledger's sanitized projection only.
  // A missing ledger is a valid empty state; an invalid one becomes a named,
  // visible error without blocking any other dashboard section.
  let routing = null;
  let routingError = null;
  try {
    routing = await new RoutingDecisionLedger(
      routingDecisionsPath(store.root),
    ).dashboardProjection();
  } catch (error) {
    routingError = {
      path: path.join(".aios", "runtime", "routing-decisions.json"),
      message: error.message,
    };
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
  const planProgress = await collectPlanProgress({
    root,
    plans,
    store,
    sessions: workerSessions,
  });
  const nextActions = deriveNextActions({ rows, plans });

  return {
    project,
    generatedAt: new Date().toISOString(),
    stateCounts,
    rows,
    errors,
    workerSessions,
    sessionError,
    routing,
    routingError,
    plans,
    planProgress,
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

function currentCategoryLabel(category) {
  const labels = {
    awaiting_approval: "Awaiting approval",
    blocked_rejected: "Blocked — rejected",
    blocked_retry_exhausted: "Blocked — retry limit exhausted",
    invalid_document: "Invalid document",
  };
  return labels[category] ?? category;
}

function renderPlanProgressCard(plan) {
  const tasks = plan.order
    .map((taskId) => {
      const position = plan.completed.includes(taskId)
        ? "done"
        : taskId === plan.currentTask
          ? "current"
          : "upcoming";
      return `<li><code>${escapeHtml(taskId)}</code> <span class="task-position">${escapeHtml(position)}</span></li>`;
    })
    .join("\n");
  const current = plan.complete
    ? '<p class="plan-complete"><strong>Complete</strong> — every ordered Task is done.</p>'
    : `<div class="field"><span class="field-label">Current Task</span><span><code>${escapeHtml(
        plan.currentTask ?? "Unavailable",
      )}</code>${plan.currentTaskState ? ` (${escapeHtml(plan.currentTaskState)})` : ""}</span></div>`;
  const durable =
    plan.currentCategory === null
      ? ""
      : `<div class="current-state ${plan.currentCategory === "invalid_document" ? "progress-error" : ""}">
           <h4>Current state</h4>
           <p><strong>${escapeHtml(currentCategoryLabel(plan.currentCategory))}</strong></p>
           <p class="operator-action"><span>Operator action:</span> ${escapeHtml(plan.action)}</p>
         </div>`;
  const historical =
    plan.lastObserved === null
      ? ""
      : `<div class="last-observed">
           <h4>Last observed <span>(historical, not live status)</span></h4>
           <div class="field"><span class="field-label">Role</span><span>${escapeHtml(plan.lastObserved.role)}</span></div>
           <div class="field"><span class="field-label">Outcome</span><span>${escapeHtml(plan.lastObserved.outcome)}</span></div>
           <div class="field"><span class="field-label">Observed at</span><span>${escapeHtml(plan.lastObserved.observedAt)}</span></div>
         </div>`;
  return `
    <article class="plan-progress-card${plan.currentCategory === "invalid_document" ? " error-card" : ""}">
      <div class="task-header">
        <h3>${escapeHtml(plan.id)}</h3>
        <span class="badge ${plan.complete ? "badge-done" : "badge-plan"}">${plan.complete ? "complete" : "in progress"}</span>
      </div>
      <div class="field"><span class="field-label">Completed</span><span>${plan.completed.length} / ${plan.order.length}</span></div>
      ${current}
      ${durable}
      ${historical}
      <div class="plan-order">
        <h4>Execution order</h4>
        ${tasks.length === 0 ? '<p class="empty-state">Task order is unavailable.</p>' : `<ol>${tasks}</ol>`}
      </div>
    </article>`;
}

function renderPlanProgress(data) {
  const content =
    data.planProgress.length === 0
      ? '<p class="empty-state">No adopted plans are available.</p>'
      : `<div class="plan-progress-grid">${data.planProgress.map(renderPlanProgressCard).join("\n")}</div>`;
  return `
    <section class="plan-progress-section" aria-labelledby="plan-progress-heading">
      <h2 id="plan-progress-heading">Plan Progress</h2>
      <p class="section-note">Current state is derived live from repository documents. Last-observed evidence is historical and may be stale.</p>
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

// --- Routing Decisions -----------------------------------------------------
// Read-only presentation of the routing ledger's sanitized projection. This
// code never re-evaluates policy, recomputes selection or distribution, or
// repairs ledger contents: it renders the recorded evidence and flags rows
// whose recorded gate evidence contradicts their own chosen candidate.

const ROUTING_DISPLACEABLE_GATES = new Set(OVERRIDE_DISPLACEABLE_REASON_CODES);

export function routingIntegrityErrors(row) {
  const errors = [];
  const chosenEntry = (row.considered ?? []).find(
    (entry) => entry.candidate === row.chosen?.candidate,
  );
  if (chosenEntry === undefined) {
    errors.push(
      `chosen candidate ${row.chosen?.candidate ?? "(missing)"} is absent from the recorded considered evidence`,
    );
    return errors;
  }
  const hardFailures = chosenEntry.reasons.filter(
    (reason) => !ROUTING_DISPLACEABLE_GATES.has(reason),
  );
  for (const code of hardFailures) {
    if (code === "tier_below_minimum" && row.workload?.work_kind === "planning") {
      errors.push(
        "planning decision was recorded below the configured high tier",
      );
    } else if (code === "tier_below_reviewer_floor") {
      errors.push(
        "Reviewer decision was recorded below its Implementer's tier",
      );
    } else {
      errors.push(`chosen candidate failed hard gate ${code}`);
    }
  }
  if (
    row.override === null &&
    hardFailures.length === 0 &&
    chosenEntry.reasons.length > 0
  ) {
    errors.push(
      `chosen candidate was recorded ineligible (${chosenEntry.reasons.join(", ")}) without an operator override`,
    );
  }
  if (
    row.workload?.work_kind === "planning" &&
    row.workload?.sources?.minimum_tier !== "routing.policy.high_tier"
  ) {
    errors.push(
      "planning decision does not record the configured high tier as its minimum",
    );
  }
  return errors;
}

export function routingBadges(row) {
  const badges = [];
  if (
    row.workload?.work_kind === "planning" &&
    row.workload?.sources?.minimum_tier === "routing.policy.high_tier"
  ) {
    badges.push("planning-high");
  }
  if (row.workload?.lower_tier?.eligible === true) {
    badges.push("lower-tier-eligible");
  }
  if (
    row.role === "reviewer" &&
    row.same_provider_review === null &&
    row.reviewer_comparison?.provider_distinct === true
  ) {
    badges.push("cross-provider review");
  }
  if (row.same_provider_review !== null) {
    badges.push("same-provider exception");
  }
  if (row.override !== null) {
    badges.push("override");
  }
  if (row.distribution?.changed_winner === true) {
    badges.push("distribution changed winner");
  }
  if (row.advanced_by === "fallback") {
    badges.push("fallback");
  }
  if (row.advanced_by === "escalation") {
    badges.push("escalation");
  }
  if (row.exhausted === true) {
    badges.push("exhausted route");
  }
  return badges;
}

function formatShare(value) {
  return value === null ? "No target" : `${(value * 100).toFixed(1)}%`;
}

function formatDeficit(value) {
  if (value === null) {
    return "No target";
  }
  if (value > 0) {
    return `+${value.toFixed(2)} under target`;
  }
  if (value < 0) {
    return `−${Math.abs(value).toFixed(2)} over target`;
  }
  return "on target";
}

function renderRoutingBadges(row) {
  const badges = routingBadges(row);
  if (badges.length === 0) {
    return "";
  }
  const items = badges
    .map((label) => `<li class="rbadge">${escapeHtml(label)}</li>`)
    .join("");
  return `<ul class="rbadges" aria-label="Routing evidence badges">${items}</ul>`;
}

function renderRoutingSummary(summary) {
  const providerRows = summary.providers
    .map(
      (entry) => `
          <tr>
            <th scope="row"><code>${escapeHtml(entry.provider)}</code></th>
            <td>${escapeHtml(formatShare(entry.target_share))}</td>
            <td>${entry.count}</td>
            <td>${escapeHtml(formatShare(entry.actual_share))}</td>
            <td>${escapeHtml(formatDeficit(entry.deficit))}</td>
          </tr>`,
    )
    .join("");
  const countList = (entries, name) =>
    entries
      .map(
        (entry) =>
          `<li><code>${escapeHtml(entry[name])}</code> — ${entry.count}</li>`,
      )
      .join("");
  return `
      <div class="routing-summary">
        <h3 id="routing-summary-heading">Decision distribution — last ${summary.observed} decisions of the configured ${summary.window}-decision window</h3>
        <p class="section-note">These are historical decision counts, not live provider capacity and not a guarantee of
          future distribution.</p>
        <div class="table-scroll">
          <table class="routing-table">
            <caption>Provider share of recorded decisions versus configured target share</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Target share</th>
                <th scope="col">Decisions</th>
                <th scope="col">Actual share</th>
                <th scope="col">Deficit / surplus</th>
              </tr>
            </thead>
            <tbody>${providerRows}
            </tbody>
          </table>
        </div>
        <div class="routing-count-lists">
          <div><h4>By model</h4><ul>${countList(summary.models, "model")}</ul></div>
          <div><h4>By tier</h4><ul>${countList(summary.tiers, "tier")}</ul></div>
          <div><h4>By Role</h4><ul>${countList(summary.roles, "role")}</ul></div>
        </div>
      </div>`;
}

function renderRoutingReason(reason) {
  if (reason === null || reason === undefined) {
    return "";
  }
  const diagnostic = reason.diagnostic
    ? ` — ${escapeHtml(reason.diagnostic)}`
    : "";
  return `<code>${escapeHtml(reason.code)}</code>${diagnostic}`;
}

function renderRoutingWorkload(row) {
  const workload = row.workload;
  const sources = workload.sources ?? {};
  const bands = [
    ["Work kind", workload.work_kind, sources.work_kind],
    ["Complexity", workload.complexity, sources.complexity],
    ["Risk", workload.risk, sources.risk],
    ["Context band", workload.context_band, sources.context_size],
    ["Verification", workload.verification, sources.verification_burden],
    [
      "Required capabilities",
      (workload.required_capabilities ?? []).join(", ") || "none",
      sources.required_capabilities,
    ],
    [
      "Budgets",
      `cost ${workload.budgets?.cost}, latency ${workload.budgets?.latency}`,
      sources.budgets,
    ],
    ["Approval", workload.approval, sources.approval],
    [
      "Retry",
      `${workload.retry?.count} / ${workload.retry?.limit}`,
      sources.retry,
    ],
    ["Minimum tier", workload.minimum_tier, sources.minimum_tier],
    [
      "Lower-tier gate",
      workload.lower_tier?.eligible
        ? "eligible"
        : `not eligible (${(workload.lower_tier?.rejection_reasons ?? []).join(", ") || "no recorded reasons"})`,
      sources.lower_tier,
    ],
  ]
    .map(
      ([label, value, source]) => `
            <tr>
              <th scope="row">${escapeHtml(label)}</th>
              <td>${escapeHtml(String(value))}</td>
              <td><code>${escapeHtml(source ?? "not recorded")}</code></td>
            </tr>`,
    )
    .join("");
  return `
        <h5>Workload evidence</h5>
        <div class="table-scroll">
          <table class="routing-table">
            <caption>Normalized workload bands and their recorded sources</caption>
            <thead>
              <tr><th scope="col">Band</th><th scope="col">Value</th><th scope="col">Source</th></tr>
            </thead>
            <tbody>${bands}
            </tbody>
          </table>
        </div>`;
}

function renderRoutingConsidered(row) {
  const entries = row.considered
    .map(
      (entry) => `
            <tr>
              <th scope="row"><code>${escapeHtml(entry.candidate)}</code></th>
              <td>${escapeHtml(entry.provider)}</td>
              <td><code>${escapeHtml(entry.model)}</code></td>
              <td>${escapeHtml(entry.tier)}</td>
              <td>${entry.eligible ? "eligible" : "ineligible"}</td>
              <td>${entry.reasons.length === 0 ? "—" : escapeHtml(entry.reasons.join(", "))}</td>
            </tr>`,
    )
    .join("");
  return `
        <h5>Considered candidates</h5>
        <div class="table-scroll">
          <table class="routing-table">
            <caption>Every considered candidate with its recorded gate outcome</caption>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Tier</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reason codes</th>
              </tr>
            </thead>
            <tbody>${entries}
            </tbody>
          </table>
        </div>`;
}

function renderRoutingDistribution(row) {
  const distribution = row.distribution;
  const deficitByProvider = new Map(
    (distribution.deficits ?? []).map((entry) => [
      entry.provider,
      `${entry.numerator}/${entry.denominator}`,
    ]),
  );
  const counts = (distribution.counts ?? [])
    .map(
      (entry) => `
            <tr>
              <th scope="row"><code>${escapeHtml(entry.provider)}</code></th>
              <td>${escapeHtml(String(entry.weight))}</td>
              <td>${entry.count}</td>
              <td>${escapeHtml(deficitByProvider.get(entry.provider) ?? "not in equivalent set")}</td>
            </tr>`,
    )
    .join("");
  return `
        <h5>Distribution evidence used</h5>
        <p>Window ${distribution.window}, ${distribution.observed} prior decisions observed;
          distribution ${distribution.applied ? "applied across providers" : "not applied (single-provider equivalent set)"};
          winner ${distribution.changed_winner ? "changed by provider deficit" : "unchanged from the fitness winner"}.
          Equivalent candidates: ${escapeHtml((distribution.equivalent ?? []).join(", "))}.</p>
        <div class="table-scroll">
          <table class="routing-table">
            <caption>Provider targets, window counts, and exact deficits recorded at decision time</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Target weight</th>
                <th scope="col">Window count</th>
                <th scope="col">Recorded deficit</th>
              </tr>
            </thead>
            <tbody>${counts}
            </tbody>
          </table>
        </div>`;
}

function renderRoutingWinner(row) {
  if (row.override === null) {
    return `
        <h5>Winner</h5>
        <p><code>${escapeHtml(row.chosen.candidate)}</code> was the normal policy winner; no override was applied.</p>`;
  }
  const override = row.override;
  return `
        <h5>Winner — operator override</h5>
        <p>Normal policy winner: <code>${escapeHtml(override.policy_winner.candidate)}</code>
          (${escapeHtml(override.policy_winner.provider)} / <code>${escapeHtml(override.policy_winner.model)}</code> / ${escapeHtml(override.policy_winner.tier)}).
          Override winner: <code>${escapeHtml(override.candidate)}</code> from ${escapeHtml(override.source)}
          selector <code>${escapeHtml(`${override.selector.task}:${override.selector.role}`)}</code>,
          fallback ${override.allow_fallback ? "allowed" : "denied"}.
          ${escapeHtml(override.displaced_rationale)}.
          Displaced budget preferences: ${override.displaced_budgets.length === 0 ? "none" : escapeHtml(override.displaced_budgets.join(", "))}.</p>`;
}

function renderRoutingSameProviderReview(row) {
  if (row.same_provider_review === null) {
    return "";
  }
  const review = row.same_provider_review;
  const disqualified = review.cross_provider_disqualified
    .map(
      (entry) =>
        `<li><code>${escapeHtml(entry.candidate)}</code>: ${escapeHtml(entry.reasons.join(", "))}</li>`,
    )
    .join("");
  return `
        <h5>Same-provider review exception</h5>
        <p>The Reviewer shares provider ${escapeHtml(review.implementer.provider)} with Implementer
          <code>${escapeHtml(review.implementer.candidate)}</code> because every cross-provider alternative
          failed a higher-priority gate:</p>
        <ul>${disqualified}</ul>`;
}

function renderRoutingEvents(row) {
  if (row.events.length === 0) {
    return "";
  }
  const events = row.events
    .map(
      (event) => `
          <li>${escapeHtml(event.kind)}${event.reason ? ` (${renderRoutingReason(event.reason)})` : ""}${
            event.session_id
              ? ` — session <code>${escapeHtml(event.session_id)}</code>`
              : ""
          } at ${escapeHtml(event.observed_at)}</li>`,
    )
    .join("");
  return `
        <h5>Routing events</h5>
        <ol class="routing-events">${events}
        </ol>`;
}

function renderRoutingSessions(row) {
  if (row.session_ids.length === 0) {
    return `
        <p class="routing-session-note">No Worker Session is linked to this decision, so the dashboard reports no
          usage or capacity for it.</p>`;
  }
  const ids = row.session_ids
    .map((id) => `<code>${escapeHtml(id)}</code>`)
    .join(", ");
  return `
        <p class="routing-session-note">Linked Worker Session id${row.session_ids.length === 1 ? "" : "s"}: ${ids}.
          Usage, cost, outcome, capacity, and refill live only in the Worker Sessions section.</p>`;
}

function renderRoutingStepEvidence(row) {
  const relation =
    row.step === 0
      ? "Initial selection (step 0)."
      : `Step ${row.step}, reached by ${escapeHtml(row.advanced_by ?? "an unknown transition")} from step ${row.parent_step}. Reason: ${renderRoutingReason(row.reason)}.`;
  return `
      <details class="routing-evidence">
        <summary>Attempt ${row.attempt}, step ${row.step}: <code>${escapeHtml(row.chosen.candidate)}</code> — ${escapeHtml(row.status)} (historical)</summary>
        <p>${relation}</p>
        ${renderRoutingBadges(row)}
        <div class="field"><span class="field-label">Policy revision</span><span><code>${escapeHtml(row.policy_revision)}</code></span></div>
        <div class="field"><span class="field-label">Decided at</span><span>${escapeHtml(row.recorded_at)}</span></div>
        <div class="field"><span class="field-label">Last observed</span><span>${escapeHtml(row.observed_at)}</span></div>
        ${renderRoutingWorkload(row)}
        ${renderRoutingConsidered(row)}
        <h5>Fitness tuple</h5>
        <p>provider_distinct ${row.fitness.provider_distinct}, tier_surplus ${row.fitness.tier_surplus},
          capability_surplus ${row.fitness.capability_surplus}, latency_rank ${row.fitness.latency_rank},
          cost_rank ${row.fitness.cost_rank}</p>
        ${renderRoutingDistribution(row)}
        ${renderRoutingWinner(row)}
        ${renderRoutingSameProviderReview(row)}
        ${renderRoutingEvents(row)}
        ${renderRoutingSessions(row)}
      </details>`;
}

function renderRoutingIntegrityCard(task, role, failures) {
  const items = failures
    .map(
      ({ row, message }) =>
        `<li>Attempt ${row.attempt}, step ${row.step}: ${escapeHtml(message)}</li>`,
    )
    .join("");
  return `
    <article class="task-card error-card routing-card routing-integrity-card">
      <div class="task-header">
        <span class="task-id">${escapeHtml(task)} · ${escapeHtml(role)}</span>
        <span class="badge badge-error">integrity error</span>
      </div>
      <p class="error-message">The recorded routing evidence contradicts itself. The dashboard is read-only and does
        not repair the ledger.</p>
      <ul class="routing-integrity-list">${items}</ul>
    </article>`;
}

function renderReviewerComparison(row) {
  if (row.role !== "reviewer") {
    return "";
  }
  if (row.reviewer_comparison === null) {
    return `
      <div class="field"><span class="field-label">Compared Implementer</span><span>No recorded Implementer decision</span></div>`;
  }
  const comparison = row.reviewer_comparison;
  return `
      <div class="field"><span class="field-label">Compared Implementer</span><span><code>${escapeHtml(
        comparison.candidate,
      )}</code> (${escapeHtml(comparison.provider)}, tier ${escapeHtml(comparison.tier)})</span></div>
      <div class="field"><span class="field-label">Different provider</span><span>${
        comparison.provider_distinct
          ? "achieved"
          : "not achieved — same-provider exception recorded"
      }</span></div>`;
}

function renderRoutingGroupCard({ task, role, rows }) {
  const failures = rows.flatMap((row) =>
    routingIntegrityErrors(row).map((message) => ({ row, message })),
  );
  if (failures.length > 0) {
    return renderRoutingIntegrityCard(task, role, failures);
  }
  const latest = rows[rows.length - 1];
  const steps = rows.map(renderRoutingStepEvidence).join("\n");
  return `
    <article class="task-card routing-card">
      <div class="task-header">
        <span class="task-id">${escapeHtml(task)} · ${escapeHtml(role)}</span>
        <span class="routing-status">${escapeHtml(latest.status)} (historical)</span>
      </div>
      <h4 class="routing-card-title">Latest decision: <code>${escapeHtml(latest.chosen.candidate)}</code></h4>
      ${renderRoutingBadges(latest)}
      <div class="field"><span class="field-label">Provider</span><span>${escapeHtml(latest.chosen.provider)}</span></div>
      <div class="field"><span class="field-label">Model</span><span><code>${escapeHtml(latest.chosen.model)}</code></span></div>
      <div class="field"><span class="field-label">Tier</span><span>${escapeHtml(latest.chosen.tier)}</span></div>
      <div class="field"><span class="field-label">Policy revision</span><span><code>${escapeHtml(latest.policy_revision)}</code></span></div>
      <div class="field"><span class="field-label">Decided at</span><span>${escapeHtml(latest.recorded_at)}</span></div>
      <div class="field"><span class="field-label">Attempt / step</span><span>${latest.attempt} / ${latest.step}</span></div>
      ${renderReviewerComparison(latest)}
      <p class="routing-historical">Historical routing decision. The Task's current state is derived from its Task
        document in the sections above, never from this route.</p>
      <details>
        <summary>Ordered routing steps (${rows.length})</summary>
        ${steps}
      </details>
    </article>`;
}

function groupRoutingDecisions(decisions) {
  const tasks = new Map();
  for (const row of decisions) {
    const roles = tasks.get(row.task) ?? new Map();
    const rows = roles.get(row.role) ?? [];
    rows.push(row);
    roles.set(row.role, rows);
    tasks.set(row.task, roles);
  }
  return [...tasks.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([task, roles]) =>
      ["implementer", "reviewer"]
        .filter((role) => roles.has(role))
        .map((role) => ({ task, role, rows: roles.get(role) })),
    );
}

function renderRoutingDecisions(data) {
  const error = data.routingError
    ? `<div class="routing-ledger-error">Routing ledger error in <code>${escapeHtml(
        data.routingError.path,
      )}</code>: ${escapeHtml(data.routingError.message)}</div>`
    : "";
  let body = "";
  if (data.routing !== null && data.routing !== undefined) {
    if (data.routing.decisions.length === 0) {
      body = '<p class="empty-state">No routing decisions have been recorded yet.</p>';
    } else {
      const cards = groupRoutingDecisions(data.routing.decisions)
        .map(renderRoutingGroupCard)
        .join("\n");
      body = `${data.routing.summary === null ? "" : renderRoutingSummary(data.routing.summary)}
      <h3 id="routing-decisions-by-task-heading">Decisions by Task and Role</h3>
      <div class="routing-grid">${cards}</div>`;
    }
  }
  return `
    <section class="routing-section" aria-labelledby="routing-heading">
      <h2 id="routing-heading">Routing Decisions</h2>
      <p class="section-note">Historical evidence of why each model candidate was chosen at dispatch time. It is not
        live provider capacity and not a guarantee of future distribution. Task state comes from Task documents, and
        the Worker Sessions section remains the sole authority for usage, cost, outcome, capacity, and refill; the two
        are linked only by session id.</p>
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
  .plan-progress-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
    gap: 1rem;
  }
  .plan-progress-card { background: #fff; border: 1px solid #cfd6df; border-radius: 8px; padding: 1rem; }
  .plan-progress-card h3 { margin: 0; }
  .plan-progress-card h4 { margin: 0 0 0.5rem; font-size: 0.95rem; }
  .plan-progress-card .field { align-items: flex-start; gap: 1rem; }
  .plan-progress-card .field > :last-child { text-align: right; overflow-wrap: anywhere; }
  .section-note { color: #5b6472; }
  .current-state, .last-observed, .plan-order { border-top: 1px solid #dde1e7; margin-top: 0.8rem; padding-top: 0.8rem; }
  .current-state p { margin: 0.35rem 0; }
  .progress-error { color: #9b1c1c; }
  .operator-action span { font-weight: 700; }
  .last-observed { background: #f6f7f9; border: 1px dashed #7b8491; border-radius: 6px; padding: 0.75rem; }
  .last-observed h4 span { color: #5b6472; font-size: 0.8rem; font-weight: 400; }
  .plan-complete { color: #166534; }
  .plan-order ol { margin: 0; padding-left: 1.5rem; }
  .plan-order li { margin: 0.25rem 0; }
  .task-position { color: #5b6472; font-size: 0.8rem; text-transform: uppercase; }
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
  .session-ledger-error, .routing-ledger-error {
    border: 1px solid #d63939;
    background: #fff;
    color: #9b1c1c;
    padding: 0.75rem;
    margin-bottom: 1rem;
    border-radius: 6px;
    overflow-wrap: anywhere;
  }
  summary:focus-visible, a:focus-visible {
    outline: 3px solid #2f6fed;
    outline-offset: 2px;
  }
  .routing-section h3 { margin: 1.25rem 0 0.5rem; }
  .routing-section h4 { margin: 0.75rem 0 0.25rem; font-size: 0.95rem; }
  .routing-section h5 { margin: 0.9rem 0 0.35rem; font-size: 0.85rem; text-transform: uppercase; color: #46515f; }
  .routing-section code { overflow-wrap: anywhere; }
  .table-scroll { overflow-x: auto; max-width: 100%; }
  .routing-table {
    border-collapse: collapse;
    background: #fff;
    font-size: 0.85rem;
    width: 100%;
  }
  .routing-table caption {
    text-align: left;
    color: #5b6472;
    font-size: 0.8rem;
    padding-bottom: 0.4rem;
  }
  .routing-table th, .routing-table td {
    border: 1px solid #dde1e7;
    padding: 0.35rem 0.6rem;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  .routing-table thead th { background: #eef1f4; }
  .routing-count-lists { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: 0.75rem; }
  .routing-count-lists ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .routing-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
    gap: 1rem;
  }
  .routing-card .task-header { align-items: flex-start; gap: 0.5rem; }
  .routing-card-title { overflow-wrap: anywhere; }
  .routing-status { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: #46515f; text-align: right; }
  .rbadges { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; padding: 0; list-style: none; }
  .rbadge {
    border: 1px solid #46515f;
    border-radius: 999px;
    color: #2c3440;
    background: #f0f2f5;
    padding: 0.1rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .routing-historical {
    color: #5b6472;
    font-size: 0.8rem;
    border-top: 1px dashed #7b8491;
    margin: 0.75rem 0 0.5rem;
    padding-top: 0.5rem;
  }
  .routing-evidence {
    border: 1px solid #dde1e7;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0.5rem 0;
  }
  .routing-evidence p, .routing-events li, .routing-session-note { font-size: 0.85rem; overflow-wrap: anywhere; }
  .routing-events { margin: 0; padding-left: 1.5rem; }
  .routing-integrity-list { font-size: 0.85rem; padding-left: 1.25rem; overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    body { padding: 1rem; }
    .counts { gap: 0.75rem; }
    .task-header { flex-wrap: wrap; row-gap: 0.35rem; }
    .routing-count-lists { flex-direction: column; gap: 0.75rem; }
    .routing-table { font-size: 0.78rem; }
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
${renderPlanProgress(data)}
${renderErrors(data)}
${renderRoutingDecisions(data)}
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
