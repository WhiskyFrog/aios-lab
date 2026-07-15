import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import {
  collectDashboardData,
  renderDashboard,
  routingBadges,
  routingIntegrityErrors,
} from "../src/dashboard.js";
import {
  decisionRecordFromSelection,
  normalizeFailureReason,
  RoutingDecisionLedger,
  routingDecisionsPath,
} from "../src/routing-ledger.js";
import { selectCandidate } from "../src/routing-policy.js";
import { SessionLedger } from "../src/sessions.js";

function taskDocument(metadata, attempts = "_None yet._") {
  const body = [
    "",
    `# ${metadata.title}`,
    "",
    "## Objective",
    "",
    "Exercise the routing dashboard.",
    "",
    "## Acceptance Criteria",
    "",
    "- The dashboard renders this Task.",
    "",
    "## Attempts",
    "",
    attempts,
    "",
  ].join("\n");
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

const ATTEMPT_FRAME = [
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
].join("\n");

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-routing-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".aios", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".aios", "reviews"), { recursive: true });
  await mkdir(path.join(root, ".aios", "approvals"), { recursive: true });
  return root;
}

async function writeTask(root, id, state = "implement", lastReview = null) {
  await writeFile(
    path.join(root, ".aios", "tasks", `${id}.md`),
    taskDocument(
      {
        schema: "aios.task/v1",
        id,
        project: "routing-dash",
        title: `Routing evidence for ${id}`,
        state,
        retry: { count: 0, limit: 2 },
        approval: "not_required",
        last_review: lastReview,
      },
      lastReview === null ? "_None yet._" : ATTEMPT_FRAME,
    ),
    "utf8",
  );
}

async function writeReview(root, id, task) {
  const metadata = {
    schema: "aios.review/v1",
    id,
    project: "routing-dash",
    task,
    attempt: 1,
    verdict: "pass",
  };
  const body = `\n# Review of ${task}, Attempt 1\n\n## Findings\n\nLooks good.\n`;
  await writeFile(
    path.join(root, ".aios", "reviews", `${id}.md`),
    `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`,
    "utf8",
  );
}

function hint(task, overrides = {}) {
  return {
    selector: { task, plan: null },
    work_kind: "implementation",
    complexity: "low",
    risk: "low",
    required_capabilities: ["filesystem"],
    verification: "objective",
    cost_budget: "high",
    latency_budget: "slow",
    ...overrides,
  };
}

function config() {
  return {
    schema: "aios.routing/v1",
    tiers: [
      { id: "lower", rank: 1 },
      { id: "high", rank: 2 },
    ],
    capabilities: ["filesystem", "shell"],
    cost_classes: ["low", "high"],
    latency_classes: ["fast", "slow"],
    candidates: [
      {
        id: "claude-lower",
        provider: "claude",
        model: "claude-configured-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "claude-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "codex-lower",
        provider: "codex",
        model: "codex-configured-lower",
        tier: "lower",
        roles: ["implementer"],
        command: [process.execPath, "codex-worker.mjs"],
        enabled: true,
        context_limit: 64_000,
        capabilities: ["filesystem"],
        cost_class: "low",
        latency_class: "fast",
      },
      {
        id: "claude-high",
        provider: "claude",
        model: "claude-configured-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "claude-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "slow",
      },
      {
        id: "codex-high",
        provider: "codex",
        model: "codex-configured-high",
        tier: "high",
        roles: ["implementer", "reviewer"],
        command: [process.execPath, "codex-worker.mjs", "--high"],
        enabled: true,
        context_limit: 200_000,
        capabilities: ["filesystem", "shell"],
        cost_class: "high",
        latency_class: "slow",
      },
    ],
    policy: {
      high_tier: "high",
      distribution_window: 20,
      provider_targets: [
        { provider: "claude", weight: 1 },
        { provider: "codex", weight: 1 },
      ],
      limits: { fallbacks_per_action: 2, escalations_per_task: 2 },
      default_budgets: { cost: "high", latency: "slow" },
    },
    hints: [
      hint("task-9001"),
      hint("task-9002"),
      hint("task-9004", { work_kind: "planning" }),
      hint("task-9005", { risk: "high" }),
      hint("task-9006"),
    ],
    overrides: [],
  };
}

function workload({
  task = "task-9001",
  role = "implementer",
  workKind = "implementation",
  risk = "low",
  lowerEligible = true,
} = {}) {
  const hintSource = `routing.hints.task:${task}`;
  const rejectionReasons = [];
  if (role !== "implementer") rejectionReasons.push("role_not_implementer");
  if (workKind !== "implementation") {
    rejectionReasons.push("work_not_bounded_implementation");
  }
  if (risk !== "low") rejectionReasons.push("risk_not_low");
  return {
    task_id: task,
    role,
    work_kind: workKind,
    parent_plan: null,
    complexity: "low",
    risk,
    context_size: { bytes: 4_000, estimated_tokens: 1_000, band: "small" },
    required_capabilities: ["filesystem"],
    verification_burden: "objective",
    budgets: { cost: "high", latency: "slow" },
    approval: "not_required",
    retry: { count: 0, limit: 2 },
    history: {
      reviews_total: 0,
      changes_requested: 0,
      sessions_failed: 0,
      capacity_deferred: 0,
    },
    uncertainty_flags: [],
    minimum_tier: lowerEligible ? "lower" : "high",
    lower_tier: { eligible: lowerEligible, rejection_reasons: rejectionReasons },
    sources: {
      task_id: "task.metadata.id",
      role: "engine.active_role",
      work_kind: hintSource,
      parent_plan: "plan_scan",
      complexity: hintSource,
      risk: hintSource,
      context_size: "task.raw_utf8",
      required_capabilities: hintSource,
      verification_burden: hintSource,
      budgets: hintSource,
      approval: "task.metadata.approval",
      retry: "task.metadata.retry",
      history: "provided_review_session_history",
      minimum_tier: lowerEligible ? "lower_tier_gate" : "routing.policy.high_tier",
      uncertainty_flags: "workload_evidence_validation",
      lower_tier: "documented_lower_tier_gate",
      diagnostics: "plan_and_history_validation",
    },
    diagnostics: {
      strict_planning_contract: false,
      plan_errors: [],
      history_errors: [],
    },
  };
}

function stamp(minute) {
  return `2026-07-14T05:${String(minute).padStart(2, "0")}:00.000Z`;
}

function historyProjection(decisions) {
  return decisions.map((record) => ({
    key: structuredClone(record.key),
    step: record.step,
    chosen: {
      candidate: record.chosen.candidate,
      provider: record.chosen.provider,
    },
    reason: record.reason === null ? null : { code: record.reason.code },
  }));
}

// Records one selected decision the same way the dispatch adapter does: the
// selection is computed from the full recorded history so the ledger's strict
// replay validation accepts the row.
async function recordDecision(ledger, minute, options) {
  const snapshot = await ledger.load();
  const selection = selectCandidate({
    config: options.config ?? config(),
    workload: options.workload,
    key: options.key,
    history: historyProjection(snapshot.decisions),
    implementerDecision: options.implementerDecision ?? null,
    recovery: options.recovery ?? null,
    override: options.override ?? null,
  });
  await ledger.record(
    snapshot,
    decisionRecordFromSelection(selection, {
      recorded_at: stamp(minute),
      reason:
        options.reason === undefined
          ? null
          : normalizeFailureReason(options.reason.code, options.reason.diagnostic),
    }),
  );
  return selection;
}

// A ledger exercising every badge and evidence state: an initial lower-tier
// pick, a capacity fallback, a verification escalation that later fails and
// exhausts, a distribution-changed winner, a planning-high decision, a
// cross-provider review, a forced same-provider review exception, and an
// operator override that displaced the policy winner.
async function buildRoutingFixture(root) {
  const ledger = new RoutingDecisionLedger(routingDecisionsPath(root));

  const key9001 = { task: "task-9001", role: "implementer", attempt: 1, policy_revision: "policy-v1" };
  await recordDecision(ledger, 1, { workload: workload(), key: key9001 });
  await recordDecision(ledger, 2, {
    workload: workload(),
    key: key9001,
    recovery: { reason_code: "capacity", previous_candidate: "claude-lower" },
    reason: { code: "capacity", diagnostic: "provider capacity window closed" },
  });
  await recordDecision(ledger, 3, {
    workload: workload(),
    key: key9001,
    recovery: { reason_code: "verification_failed", previous_candidate: "codex-lower" },
    reason: { code: "verification_failed", diagnostic: "tests failed twice" },
  });

  await recordDecision(ledger, 4, {
    workload: workload({ task: "task-9002" }),
    key: { task: "task-9002", role: "implementer", attempt: 1, policy_revision: "policy-v1" },
  });

  await recordDecision(ledger, 5, {
    workload: workload({ task: "task-9004", workKind: "planning", lowerEligible: false }),
    key: { task: "task-9004", role: "implementer", attempt: 1, policy_revision: "policy-v1" },
  });

  await recordDecision(ledger, 6, {
    workload: workload({ role: "reviewer", lowerEligible: false }),
    key: { task: "task-9001", role: "reviewer", attempt: 1, policy_revision: "policy-v1" },
    implementerDecision: {
      task: "task-9001",
      attempt: 1,
      candidate: "claude-high",
      provider: "claude",
      tier: "high",
    },
  });

  await recordDecision(ledger, 7, {
    workload: workload({ task: "task-9005", risk: "high", lowerEligible: false }),
    key: { task: "task-9005", role: "implementer", attempt: 1, policy_revision: "policy-v1" },
  });
  const samProviderConfig = config();
  samProviderConfig.candidates.find(({ id }) => id === "codex-high").enabled = false;
  await recordDecision(ledger, 8, {
    config: samProviderConfig,
    workload: workload({ task: "task-9005", role: "reviewer", risk: "high", lowerEligible: false }),
    key: { task: "task-9005", role: "reviewer", attempt: 1, policy_revision: "policy-v1" },
    implementerDecision: {
      task: "task-9005",
      attempt: 1,
      candidate: "claude-high",
      provider: "claude",
      tier: "high",
    },
  });

  await recordDecision(ledger, 9, {
    workload: workload({ task: "task-9006" }),
    key: { task: "task-9006", role: "implementer", attempt: 1, policy_revision: "policy-v1" },
    override: {
      candidate: "claude-lower",
      source: "cli",
      selector: { task: "task-9006", role: "implementer" },
      allow_fallback: false,
      displaced_config_candidate: null,
    },
  });

  // Launch, fail, and exhaust the escalated task-9001 step so the exhausted
  // badge, the sanitized event diagnostics, and the session link all exist.
  let snapshot = await ledger.load();
  snapshot = await ledger.appendEvent(snapshot, {
    key: key9001,
    step: 2,
    kind: "launch",
    session_id: "sess-imp-9001",
    observed_at: stamp(10),
  });
  snapshot = await ledger.appendEvent(snapshot, {
    key: key9001,
    step: 2,
    kind: "failure",
    reason: {
      code: "provider_failure",
      diagnostic:
        "Bearer sekrit-token-12345 at C:\\Users\\djEjg\\secret <script>alert(1)</script>",
    },
    session_id: "sess-imp-9001",
    observed_at: stamp(11),
  });
  await ledger.appendEvent(snapshot, {
    key: key9001,
    step: 2,
    kind: "exhausted",
    reason: { code: "routing_exhausted", diagnostic: "bounded fallbacks exhausted" },
    observed_at: stamp(12),
  });

  return ledger;
}

function routingSection(html) {
  return /<section class="routing-section"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

function findRow(data, task, role, step) {
  return data.routing.decisions.find(
    (row) => row.task === task && row.role === role && row.step === step,
  );
}

test("a missing routing ledger is an explicit empty state and changes nothing else", async (t) => {
  const root = await makeRoot(t);
  await writeTask(root, "task-0001");

  const missing = await collectDashboardData(root);
  assert.equal(missing.routingError, null);
  assert.deepEqual(missing.routing.decisions, []);
  assert.equal(missing.routing.summary, null);

  const missingHtml = renderDashboard({ ...missing, generatedAt: "fixed" });
  const section = routingSection(missingHtml);
  assert.match(section, /Routing Decisions/);
  assert.match(section, /No routing decisions have been recorded yet\./);
  assert.doesNotMatch(section, /routing-table|routing-card/);

  // An empty valid ledger renders byte-identically to a missing one.
  await mkdir(path.join(root, ".aios", "runtime"), { recursive: true });
  await writeFile(
    routingDecisionsPath(root),
    '{"schema":"aios.routing-decisions/v1","updated_at":null,"decisions":[]}',
    "utf8",
  );
  const empty = await collectDashboardData(root);
  assert.equal(
    renderDashboard({ ...empty, generatedAt: "fixed" }),
    missingHtml,
  );
});

test("an invalid routing ledger is a named visible error that blocks nothing else", async (t) => {
  const root = await makeRoot(t);
  await writeTask(root, "task-0001");
  await new SessionLedger(path.join(root, ".aios", "runtime", "sessions.json")).record({
    id: "session-still-visible",
    task: "task-0001",
    role: "implementer",
    model: "fixture-model",
    started_at: "2026-07-14T01:00:00Z",
    observed_at: "2026-07-14T01:01:00Z",
    outcome: "completed",
    usage: null,
    cost_usd: null,
    capacity: null,
  });
  await writeFile(routingDecisionsPath(root), "not-json", "utf8");

  const data = await collectDashboardData(root);
  assert.equal(data.routing, null);
  assert.match(data.routingError.path, /routing-decisions\.json/);
  assert.match(data.routingError.message, /valid JSON/);

  const html = renderDashboard(data);
  assert.match(html, /Routing ledger error in <code>[^<]*routing-decisions\.json/);
  assert.match(html, /valid JSON/);
  assert.match(html, /task-0001/);
  assert.match(html, /Worker Sessions/);
  assert.match(html, /session-still-visible/);
  assert.match(html, /Plan proposals awaiting adoption/);

  const schemaViolation = await makeRoot(t);
  await mkdir(path.join(schemaViolation, ".aios", "runtime"), { recursive: true });
  await writeFile(
    routingDecisionsPath(schemaViolation),
    '{"schema":"aios.routing-decisions/v2","updated_at":null,"decisions":[]}',
    "utf8",
  );
  const invalid = await collectDashboardData(schemaViolation);
  assert.match(invalid.routingError.message, /schema/);
});

test("the summary reports window counts, target versus actual shares, and signed deficits", async (t) => {
  const root = await makeRoot(t);
  const ledger = new RoutingDecisionLedger(routingDecisionsPath(root));
  await recordDecision(ledger, 1, {
    workload: workload(),
    key: { task: "task-9001", role: "implementer", attempt: 1, policy_revision: "policy-v1" },
  });

  const data = await collectDashboardData(root);
  const summary = data.routing.summary;
  assert.equal(summary.window, 20);
  assert.equal(summary.observed, 1);
  assert.deepEqual(summary.providers, [
    {
      provider: "claude",
      weight: 1,
      target_share: 0.5,
      count: 1,
      actual_share: 1,
      deficit: -0.5,
    },
    {
      provider: "codex",
      weight: 1,
      target_share: 0.5,
      count: 0,
      actual_share: 0,
      deficit: 0.5,
    },
  ]);
  assert.deepEqual(summary.models, [{ model: "claude-configured-lower", count: 1 }]);
  assert.deepEqual(summary.tiers, [{ tier: "lower", count: 1 }]);
  assert.deepEqual(summary.roles, [{ role: "implementer", count: 1 }]);

  const section = routingSection(renderDashboard(data));
  assert.match(section, /configured 20-decision window/);
  assert.match(section, /50\.0%/);
  assert.match(section, /100\.0%/);
  assert.match(section, /\+0\.50 under target/);
  assert.match(section, /−0\.50 over target/);
  assert.match(section, /historical decision counts, not live provider capacity/);
  assert.match(section, /not a guarantee of\s+future distribution/);
});

test("badges and evidence cover every documented routing state", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  const data = await collectDashboardData(root);

  assert.deepEqual(routingBadges(findRow(data, "task-9001", "implementer", 0)), [
    "lower-tier-eligible",
  ]);
  assert.deepEqual(routingBadges(findRow(data, "task-9001", "implementer", 1)), [
    "lower-tier-eligible",
    "fallback",
  ]);
  const escalated = findRow(data, "task-9001", "implementer", 2);
  assert.deepEqual(routingBadges(escalated), [
    "lower-tier-eligible",
    "escalation",
    "exhausted route",
  ]);
  assert.equal(escalated.advanced_by, "escalation");
  assert.equal(escalated.parent_step, 1);
  assert.equal(escalated.status, "failed");
  assert.deepEqual(escalated.session_ids, ["sess-imp-9001"]);

  const changed = findRow(data, "task-9002", "implementer", 0);
  assert.equal(changed.distribution.changed_winner, true);
  assert.deepEqual(routingBadges(changed), [
    "lower-tier-eligible",
    "distribution changed winner",
  ]);

  assert.deepEqual(routingBadges(findRow(data, "task-9004", "implementer", 0)), [
    "planning-high",
  ]);

  const crossReview = findRow(data, "task-9001", "reviewer", 0);
  assert.deepEqual(routingBadges(crossReview), ["cross-provider review"]);
  assert.deepEqual(crossReview.reviewer_comparison, {
    candidate: "claude-high",
    provider: "claude",
    model: "claude-configured-high",
    tier: "high",
    provider_distinct: true,
  });

  const sameReview = findRow(data, "task-9005", "reviewer", 0);
  assert.deepEqual(routingBadges(sameReview), ["same-provider exception"]);
  assert.equal(sameReview.reviewer_comparison.provider_distinct, false);
  assert.equal(sameReview.same_provider_review.implementer.candidate, "claude-high");

  const overridden = findRow(data, "task-9006", "implementer", 0);
  assert.deepEqual(routingBadges(overridden), [
    "lower-tier-eligible",
    "override",
    "distribution changed winner",
  ]);
  assert.equal(overridden.chosen.candidate, "claude-lower");
  assert.equal(overridden.override.policy_winner.candidate, "codex-lower");

  const html = renderDashboard(data);
  const section = routingSection(html);
  for (const badge of [
    "planning-high",
    "lower-tier-eligible",
    "cross-provider review",
    "same-provider exception",
    "override",
    "distribution changed winner",
    "fallback",
    "escalation",
    "exhausted route",
  ]) {
    assert.ok(section.includes(`<li class="rbadge">${badge}</li>`), `badge ${badge}`);
  }

  // Compact view fields and expanded evidence.
  assert.match(section, /task-9001 · implementer/);
  assert.match(section, /Latest decision: <code>claude-high<\/code>/);
  assert.match(section, /Policy revision<\/span><span><code>policy-v1<\/code>/);
  assert.match(section, /Ordered routing steps \(3\)/);
  assert.match(section, /Initial selection \(step 0\)\./);
  assert.match(section, /reached by fallback from step 0/);
  assert.match(section, /reached by escalation from step 1/);
  assert.match(section, /provider capacity window closed/);
  assert.match(section, /Workload evidence/);
  assert.match(section, /routing\.hints\.task:task-9001/);
  assert.match(section, /Considered candidates/);
  assert.match(section, /prior_step_candidate/);
  assert.match(section, /Fitness tuple/);
  assert.match(section, /provider_distinct \d/);
  assert.match(section, /Distribution evidence used/);
  assert.match(section, /Recorded deficit/);
  assert.match(section, /Winner — operator override/);
  assert.match(section, /Normal policy winner: <code>codex-lower<\/code>/);
  assert.match(section, /Override winner: <code>claude-lower<\/code>/);
  assert.match(section, /override displaced normal policy winner codex-lower/);
  assert.match(section, /Same-provider review exception/);
  assert.match(section, /failed a higher-priority gate/);
  assert.match(section, /candidate_disabled/);
  assert.match(section, /Compared Implementer/);
  assert.match(section, /tier high/);
  assert.match(section, /Different provider<\/span><span>achieved/);
  assert.match(section, /not achieved — same-provider exception recorded/);
  assert.match(section, /Routing events/);
  assert.match(section, /exhausted/);
});

test("routing evidence is sanitized, escaped, and free of dispatch internals", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  const data = await collectDashboardData(root);

  const projected = JSON.stringify(data.routing);
  assert.doesNotMatch(projected, /command|argv|environment|continuation|prompt/i);
  assert.doesNotMatch(projected, /worker\.mjs|node\.exe/i);
  assert.doesNotMatch(projected, /sekrit-token-12345/);

  const html = renderDashboard(data);
  assert.doesNotMatch(html, /worker\.mjs/);
  assert.doesNotMatch(html, /sekrit-token-12345/);
  assert.doesNotMatch(html, /C:\\Users/);
  assert.match(html, /Bearer \[redacted\]/);
  assert.match(html, /\[path\]/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("routing and session telemetry stay separate and link only by session id", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  await new SessionLedger(path.join(root, ".aios", "runtime", "sessions.json")).record({
    id: "sess-imp-9001",
    task: "task-9001",
    role: "implementer",
    model: "claude-configured-high",
    started_at: "2026-07-14T05:10:00Z",
    observed_at: "2026-07-14T05:11:00Z",
    outcome: "failed",
    usage: {
      input_tokens: 111,
      output_tokens: 22,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    cost_usd: 0.5,
    capacity: { status: "allowed", utilization: 0.4, resets_at: null },
  });

  const html = renderDashboard(await collectDashboardData(root));
  const section = routingSection(html);
  assert.match(section, /sess-imp-9001/);
  assert.match(
    section,
    /Usage, cost, outcome, capacity, and refill live only in the Worker Sessions section/,
  );
  assert.doesNotMatch(section, /Tokens|Cost|Capacity used|Refill/);
  assert.doesNotMatch(section, /133|0\.5000|40%/);
  assert.match(
    section,
    /No Worker Session is linked to this decision, so the dashboard reports no\s+usage or capacity for it\./,
  );
  const sessionsSection = /<section class="sessions-section"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(sessionsSection, /sess-imp-9001/);
  assert.match(sessionsSection, /133 total/);
});

test("historical failed routes never override the Task's current documented state", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  await writeReview(root, "review-0001", "task-9001");
  await writeTask(root, "task-9001", "done", "review-0001");

  const data = await collectDashboardData(root);
  assert.equal(data.stateCounts.done, 1);
  const html = renderDashboard(data);
  const section = routingSection(html);
  assert.match(section, /failed \(historical\)/i);
  assert.match(
    section,
    /Historical routing decision\. The Task's current state is derived from its Task\s+document/,
  );
  const doneSection = /<section class="tasks-section done-section"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(doneSection, /task-9001/);
  assert.match(doneSection, /badge-done/);
});

function malformedRow(overrides = {}) {
  return {
    key_string: "task-0001:implementer:1:policy-v1",
    task: "task-0001",
    role: "implementer",
    attempt: 1,
    policy_revision: "policy-v1",
    step: 0,
    parent_step: null,
    status: "completed",
    reason: null,
    advanced_by: null,
    exhausted: false,
    session_ids: [],
    workload: {
      work_kind: "planning",
      lower_tier: { eligible: false, rejection_reasons: ["work_not_bounded_implementation"] },
      sources: { minimum_tier: "routing.policy.high_tier" },
      minimum_tier: "high",
      required_capabilities: [],
      budgets: { cost: "high", latency: "slow" },
      retry: { count: 0, limit: 2 },
    },
    considered: [
      {
        candidate: "low-bot",
        provider: "prov",
        model: "prov-model",
        tier: "lower",
        eligible: false,
        reasons: ["tier_below_minimum"],
      },
    ],
    chosen: { candidate: "low-bot", provider: "prov", model: "prov-model", tier: "lower" },
    fitness: null,
    distribution: { applied: false, changed_winner: false },
    override: null,
    same_provider_review: null,
    reviewer_comparison: null,
    events: [],
    recorded_at: "2026-07-14T05:00:00.000Z",
    observed_at: "2026-07-14T05:00:00.000Z",
    ...overrides,
  };
}

test("malformed planning or reviewer rows become integrity-error cards, never badges", async (t) => {
  const root = await makeRoot(t);
  const base = await collectDashboardData(root);

  const planningBelowHigh = malformedRow();
  const reviewerBelowImplementer = malformedRow({
    key_string: "task-0002:reviewer:1:policy-v1",
    task: "task-0002",
    role: "reviewer",
    workload: {
      ...malformedRow().workload,
      work_kind: "implementation",
      sources: { minimum_tier: "routing.policy.high_tier" },
    },
    considered: [
      {
        candidate: "low-bot",
        provider: "prov",
        model: "prov-model",
        tier: "lower",
        eligible: false,
        reasons: ["tier_below_reviewer_floor"],
      },
    ],
  });

  assert.deepEqual(routingIntegrityErrors(planningBelowHigh), [
    "planning decision was recorded below the configured high tier",
  ]);
  assert.deepEqual(routingIntegrityErrors(reviewerBelowImplementer), [
    "Reviewer decision was recorded below its Implementer's tier",
  ]);

  const html = renderDashboard({
    ...base,
    routing: {
      schema: "aios.routing-decisions/v1",
      updated_at: "2026-07-14T05:00:00.000Z",
      decisions: [planningBelowHigh, reviewerBelowImplementer],
      summary: null,
    },
  });
  const section = routingSection(html);
  assert.match(section, /routing-integrity-card/);
  assert.match(section, /integrity error/);
  assert.match(section, /planning decision was recorded below the configured high tier/);
  assert.match(section, /Reviewer decision was recorded below its Implementer&#39;s tier/);
  assert.match(section, /read-only and does\s+not repair the ledger/);
  assert.doesNotMatch(section, /rbadge/);
  assert.doesNotMatch(section, /Latest decision:/);
});

test("well-formed ledgers report no integrity errors", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  const data = await collectDashboardData(root);
  for (const row of data.routing.decisions) {
    assert.deepEqual(routingIntegrityErrors(row), [], row.key_string);
  }
  assert.doesNotMatch(routingSection(renderDashboard(data)), /integrity error/);
});

test("the routing view stays accessible and responsive", async (t) => {
  const root = await makeRoot(t);
  await buildRoutingFixture(root);
  const html = renderDashboard(await collectDashboardData(root));
  const section = routingSection(html);

  assert.match(section, /<section class="routing-section" aria-labelledby="routing-heading">/);
  assert.match(section, /<h2 id="routing-heading">Routing Decisions<\/h2>/);
  assert.match(section, /<th scope="col">/);
  assert.match(section, /<th scope="row">/);
  assert.match(section, /<caption>/);
  assert.match(section, /<details>/);
  assert.match(section, /<details class="routing-evidence">/);
  assert.match(section, /<summary>/);
  assert.match(section, /aria-label="Routing evidence badges"/);
  assert.match(section, /class="table-scroll"/);

  assert.match(html, /summary:focus-visible, a:focus-visible/);
  assert.match(html, /\.table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.match(html, /@media \(max-width: 480px\)/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);

  const headingIds = new Set(
    (html.match(/<h[1-6] id="([^"]+)"/g) ?? []).map((tag) => tag.match(/id="([^"]+)"/)[1]),
  );
  for (const labelled of section.match(/aria-labelledby="([^"]+)"/g) ?? []) {
    assert.ok(headingIds.has(labelled.match(/aria-labelledby="([^"]+)"/)[1]));
  }
});
