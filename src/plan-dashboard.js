import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parseDocumentFile } from "./documents.js";

const PROPOSAL_FILE = /^P-[0-9]{2,}\.md$/;
const PLACEHOLDER_REFERENCE = /\bP-[0-9]{2,}\b/;

export async function collectPlanProposals(root) {
  const plansDirectory = path.join(path.resolve(root), "plans");
  let entries;
  try {
    entries = await readdir(plansDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { plans: [], errors: [] };
    }
    throw error;
  }

  const plans = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const planDirectory = path.join(plansDirectory, entry.name);

    let planEntries;
    try {
      planEntries = await readdir(planDirectory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        plan: entry.name,
        message: `unable to read plan directory: ${error.message}`,
      });
      continue;
    }
    const proposalCount = planEntries.filter(
      (planEntry) => planEntry.isFile() && PROPOSAL_FILE.test(planEntry.name),
    ).length;

    let metadata;
    let body;
    try {
      const raw = await readFile(path.join(planDirectory, "PLAN.md"), "utf8");
      ({ metadata, body } = parseDocumentFile(raw, "PLAN.md"));
    } catch (error) {
      errors.push({ plan: entry.name, message: error.message });
      continue;
    }

    plans.push({
      id: typeof metadata?.id === "string" ? metadata.id : entry.name,
      profile: metadata?.profile ?? null,
      proposalCount,
      adopted: !PLACEHOLDER_REFERENCE.test(body),
    });
  }

  return { plans, errors };
}

export function deriveNextActions({ rows = [], plans = [] } = {}) {
  const actions = [];
  for (const row of rows) {
    if (row.state === "approval" && row.awaitingApproval) {
      actions.push({
        kind: "approval",
        id: row.id,
        message: `Approve or reject ${row.id}`,
      });
    } else if (row.state === "blocked") {
      actions.push({
        kind: "blocked",
        id: row.id,
        message: `Unblock ${row.id}`,
      });
    }
  }
  for (const plan of plans) {
    if (!plan.adopted) {
      actions.push({
        kind: "plan-adoption",
        id: plan.id,
        message: `Adopt plan ${plan.id}`,
      });
    }
  }
  return actions;
}
