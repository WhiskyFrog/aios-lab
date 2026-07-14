import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { collectPlanProposals, deriveNextActions } from "../src/plan-dashboard.js";

function render(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function planDocument({
  id,
  profile = "website",
  profileReason = "The brief is a multi-page website.",
  adopted = false,
} = {}) {
  const executionReference = adopted ? "task-0099" : "P-01";
  return render(
    { schema: "aios.plan/v1", id, project: "test-project", profile, profile_reason: profileReason },
    `
# Demo plan

## Brief

Build a small responsive website.

## Execution Order

1. ${executionReference} is the next outcome.
`,
  );
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aios-plan-dashboard-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makePlan(root, name, options = {}) {
  const planDirectory = path.join(root, "plans", name);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(
    path.join(planDirectory, "PLAN.md"),
    planDocument({ id: name, ...options }),
    "utf8",
  );
  const proposalIds = options.proposalIds ?? ["P-01"];
  for (const proposalId of proposalIds) {
    await writeFile(path.join(planDirectory, `${proposalId}.md`), "placeholder proposal", "utf8");
  }
  return planDirectory;
}

test("collectPlanProposals reports fully adopted plans as adopted with no errors", async (t) => {
  const root = await makeRoot(t);
  await makePlan(root, "site-plan", { adopted: true, proposalIds: ["P-01", "P-02"] });

  const result = await collectPlanProposals(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.plans, [
    { id: "site-plan", directory: "site-plan", profile: "website", proposalCount: 2, adopted: true },
  ]);
});

test("collectPlanProposals reports pending plans as not adopted", async (t) => {
  const root = await makeRoot(t);
  await makePlan(root, "pending-plan", { adopted: false, proposalIds: ["P-01"] });

  const result = await collectPlanProposals(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.plans, [
    { id: "pending-plan", directory: "pending-plan", profile: "website", proposalCount: 1, adopted: false },
  ]);
});

test("collectPlanProposals yields an empty list when plans/ does not exist", async (t) => {
  const root = await makeRoot(t);

  const result = await collectPlanProposals(root);
  assert.deepEqual(result, { plans: [], errors: [] });
});

test("collectPlanProposals reports an unparsable PLAN.md as a named error without aborting", async (t) => {
  const root = await makeRoot(t);
  await makePlan(root, "good-plan", { adopted: true, proposalIds: ["P-01"] });
  const brokenDirectory = path.join(root, "plans", "broken-plan");
  await mkdir(brokenDirectory, { recursive: true });
  await writeFile(path.join(brokenDirectory, "PLAN.md"), "not a document at all", "utf8");
  await writeFile(path.join(brokenDirectory, "P-01.md"), "placeholder", "utf8");

  const result = await collectPlanProposals(root);
  assert.deepEqual(result.plans, [
    { id: "good-plan", directory: "good-plan", profile: "website", proposalCount: 1, adopted: true },
  ]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].plan, "broken-plan");
  assert.match(result.errors[0].message, /front matter/);
});

test("collectPlanProposals reports a missing PLAN.md as a named error", async (t) => {
  const root = await makeRoot(t);
  const planDirectory = path.join(root, "plans", "no-plan-file");
  await mkdir(planDirectory, { recursive: true });
  await writeFile(path.join(planDirectory, "P-01.md"), "placeholder", "utf8");

  const result = await collectPlanProposals(root);
  assert.deepEqual(result.plans, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].plan, "no-plan-file");
});

function row(overrides) {
  return {
    id: "task-0001",
    state: "implement",
    awaitingApproval: false,
    ...overrides,
  };
}

test("deriveNextActions returns an empty array when there is nothing to act on", () => {
  const actions = deriveNextActions({
    rows: [row({ id: "task-0001", state: "implement" }), row({ id: "task-0002", state: "done" })],
    plans: [{ id: "adopted-plan", profile: "website", proposalCount: 1, adopted: true }],
  });
  assert.deepEqual(actions, []);
});

test("deriveNextActions reports a single next action for one awaiting-approval Task", () => {
  const actions = deriveNextActions({
    rows: [row({ id: "task-0003", state: "approval", awaitingApproval: true })],
    plans: [],
  });
  assert.deepEqual(actions, [
    { kind: "approval", id: "task-0003", message: "Approve or reject task-0003" },
  ]);
});

test("deriveNextActions ignores approval Tasks whose decision file already exists", () => {
  const actions = deriveNextActions({
    rows: [row({ id: "task-0004", state: "approval", awaitingApproval: false })],
    plans: [],
  });
  assert.deepEqual(actions, []);
});

test("deriveNextActions reports multiple next actions from blocked Tasks and pending plans", () => {
  const actions = deriveNextActions({
    rows: [
      row({ id: "task-0005", state: "approval", awaitingApproval: true }),
      row({ id: "task-0006", state: "blocked" }),
      row({ id: "task-0007", state: "implement" }),
    ],
    plans: [
      { id: "pending-plan", profile: "website", proposalCount: 1, adopted: false },
      { id: "adopted-plan", profile: "website", proposalCount: 1, adopted: true },
    ],
  });
  assert.deepEqual(actions, [
    { kind: "approval", id: "task-0005", message: "Approve or reject task-0005" },
    { kind: "blocked", id: "task-0006", message: "Unblock task-0006" },
    { kind: "plan-adoption", id: "pending-plan", message: "Adopt plan pending-plan" },
  ]);
});

test("deriveNextActions defaults to empty rows and plans", () => {
  assert.deepEqual(deriveNextActions(), []);
});
