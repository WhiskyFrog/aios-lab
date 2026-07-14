import { createHash } from "node:crypto";
import path from "node:path";

import { TaskStore } from "./documents.js";
import {
  decisionRecordFromSelection,
  normalizeFailureReason,
  RoutingDecisionLedger,
  routingDecisionsPath,
} from "./routing-ledger.js";
import {
  NoEligibleCandidateError,
  RoutingPolicyError,
  selectCandidate,
} from "./routing-policy.js";
import {
  buildWorkloadContext,
  loadExecutionConfig,
  validateRoutingConfig,
} from "./routing.js";
import { SessionLedger } from "./sessions.js";
import {
  CapacityDeferredError,
  CommandWorker,
  ProviderFailureError,
  WorkerError,
  WorkerTimeoutError,
} from "./workers.js";

const ROUTED_ROLES = new Set(["implementer", "reviewer"]);
const RECOVERABLE_RESULT_KINDS = new Set([
  "verification_failed",
  "context_insufficient",
]);
const ESCALATION_RECOVERY_REASONS = new Set([
  "verification_failed",
  "context_insufficient",
  "repeated_evidence",
]);
const RECOVERY_REASONS = new Set([
  "capacity",
  "timeout",
  "provider_failure",
  "verification_failed",
  "context_insufficient",
  "repeated_evidence",
]);

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function routingPolicyRevision(config) {
  const normalized = validateRoutingConfig(config);
  return `policy-${createHash("sha256")
    .update(stableStringify(normalized))
    .digest("hex")
    .slice(0, 20)}`;
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

function candidateFor(config, id) {
  const candidate = config.candidates.find((entry) => entry.id === id);
  if (candidate === undefined) {
    throw new WorkerError(`Routing candidate ${id} is no longer configured`);
  }
  return candidate;
}

function implementerDecisionFor(decisions, key) {
  if (key.role !== "reviewer") {
    return null;
  }
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const record = decisions[index];
    if (
      record.key.task === key.task &&
      record.key.role === "implementer" &&
      record.key.attempt === key.attempt
    ) {
      return {
        task: key.task,
        attempt: key.attempt,
        candidate: record.chosen.candidate,
        provider: record.chosen.provider,
        tier: record.chosen.tier,
      };
    }
  }
  return null;
}

function recoveryError(error) {
  return (
    error instanceof NoEligibleCandidateError ||
    error instanceof RoutingPolicyError
  );
}

export class RoutingExhaustedError extends WorkerError {
  constructor(reason, options = undefined) {
    super(`Bounded routing exhausted after ${reason}`, options);
    this.name = "RoutingExhaustedError";
  }
}

class RoutedWorker {
  constructor({
    root,
    configPath,
    config,
    revision,
    workload,
    key,
    selection,
    decisionLedger,
    sessionLedger,
    store,
    timeoutMs,
  }) {
    this.root = root;
    this.configPath = configPath;
    this.config = config;
    this.revision = revision;
    this.workload = workload;
    this.key = key;
    this.selection = selection;
    this.decisionLedger = decisionLedger;
    this.sessionLedger = sessionLedger;
    this.store = store;
    this.timeoutMs = timeoutMs;
    this.pendingRecovery = null;
    this.deferredCandidate = null;
    this.lastSessionId = null;
  }

  requestRecovery(reason) {
    if (!RECOVERY_REASONS.has(reason)) {
      throw new WorkerError(`Unknown routed recovery reason ${String(reason)}`);
    }
    this.pendingRecovery = reason;
  }

  async #freshConfig() {
    const loaded = await loadExecutionConfig(this.configPath);
    if (loaded.kind !== "routing") {
      throw new WorkerError("Routing configuration changed schema during an action");
    }
    if (routingPolicyRevision(loaded.config) !== this.revision) {
      throw new WorkerError("Routing policy changed during an active decision action");
    }
    this.config = loaded.config;
    return loaded.config;
  }

  async #event(kind, reason = null, diagnostic = "", sessionId = this.lastSessionId) {
    const snapshot = await this.decisionLedger.load();
    const active = snapshot.decisions.find(
      (record) =>
        record.key.task === this.key.task &&
        record.key.role === this.key.role &&
        record.key.attempt === this.key.attempt &&
        record.key.policy_revision === this.key.policy_revision &&
        record.step === this.selection.step,
    );
    if (active === undefined) {
      throw new WorkerError("The active routing decision disappeared from its ledger");
    }
    await this.decisionLedger.appendEvent(snapshot, {
      key: this.key,
      step: this.selection.step,
      kind,
      reason: reason === null ? null : { code: reason, diagnostic },
      session_id: sessionId,
      observed_at: new Date().toISOString(),
    });
  }

  async #advance(task, reason, diagnostic) {
    if (!(await this.store.taskIsUnchanged(task))) {
      throw new WorkerError(
        "Task changed before routed fallback; no additional Worker was launched",
      );
    }
    if (reason === "capacity") {
      await this.#event("capacity_pause", reason, diagnostic);
    }
    const config = await this.#freshConfig();
    let snapshot = await this.decisionLedger.load();
    let next;
    try {
      next = selectCandidate({
        config,
        workload: this.workload,
        key: this.key,
        history: historyProjection(snapshot.decisions),
        implementerDecision: implementerDecisionFor(snapshot.decisions, this.key),
        recovery: {
          reason_code: reason,
          previous_candidate: this.selection.chosen.candidate,
        },
      });
    } catch (error) {
      if (reason === "capacity" && recoveryError(error)) {
        return false;
      }
      await this.#event("failure", reason, diagnostic);
      await this.#event("exhausted", "routing_exhausted", reason);
      if (recoveryError(error)) {
        throw new RoutingExhaustedError(reason, { cause: error });
      }
      throw error;
    }

    await this.#event("failure", reason, diagnostic);
    await this.#event(
      ESCALATION_RECOVERY_REASONS.has(reason)
        ? "escalation"
        : "fallback",
      reason,
      diagnostic,
    );
    snapshot = await this.decisionLedger.load();
    const timestamp = new Date().toISOString();
    const record = decisionRecordFromSelection(next, {
      recorded_at: timestamp,
      reason: normalizeFailureReason(reason, diagnostic),
    });
    await this.decisionLedger.record(snapshot, record);
    this.selection = next;
    this.pendingRecovery = null;
    this.deferredCandidate = null;
    this.lastSessionId = null;
    return true;
  }

  async accept() {
    await this.#event("completion");
  }

  async rejectResult(diagnostic) {
    await this.#event("failure", "invalid_result", diagnostic);
  }

  async execute(task, { continuation = null, signal = undefined } = {}) {
    if (this.pendingRecovery !== null) {
      const reason = this.pendingRecovery;
      if (!(await this.#advance(task, reason, reason))) {
        throw new RoutingExhaustedError(reason);
      }
      continuation = null;
    }

    while (true) {
      const candidate = candidateFor(this.config, this.selection.chosen.candidate);
      if (
        continuation !== null &&
        this.deferredCandidate !== null &&
        this.deferredCandidate !== candidate.id
      ) {
        throw new WorkerError("A provider continuation cannot cross routing candidates");
      }
      const snapshot = await this.decisionLedger.resolveKey(this.key);
      if (snapshot?.active.status === "selected") {
        await this.#event("launch", null, "", null);
      } else {
        await this.#event("launch", null, "", continuation === null ? null : this.lastSessionId);
      }
      const commandWorker = new CommandWorker(candidate.command, {
        cwd: this.root,
        timeoutMs: this.timeoutMs,
        ledger: this.sessionLedger,
      });
      try {
        const result = await commandWorker.execute(task, { continuation, signal });
        this.lastSessionId = commandWorker.lastExecution?.sessionId ?? null;
        this.deferredCandidate = null;
        if (
          result?.status === "failure" &&
          RECOVERABLE_RESULT_KINDS.has(result.payload?.failure_kind)
        ) {
          const reason = result.payload.failure_kind;
          await this.#advance(task, reason, result.payload.reason);
          continuation = null;
          continue;
        }
        if (result?.status === "failure") {
          await this.#event(
            "failure",
            "worker_reported_failure",
            result.payload?.reason ?? "",
          );
        }
        return result;
      } catch (error) {
        this.lastSessionId = commandWorker.lastExecution?.sessionId ?? this.lastSessionId;
        let reason = null;
        if (error instanceof CapacityDeferredError) reason = "capacity";
        else if (error instanceof WorkerTimeoutError) reason = "timeout";
        else if (error instanceof ProviderFailureError) reason = "provider_failure";
        if (reason === null) {
          throw error;
        }
        const advanced = await this.#advance(task, reason, error.message);
        if (!advanced) {
          this.deferredCandidate = candidate.id;
          throw error;
        }
        continuation = null;
      }
    }
  }
}

export class RoutedAssignmentResolver {
  constructor(
    configPath,
    { cwd, timeoutMs = 300_000, ledger = null, decisionLedger = null, store = null } = {},
  ) {
    this.configPath = path.resolve(configPath);
    this.root = path.resolve(cwd ?? path.dirname(this.configPath));
    this.timeoutMs = timeoutMs;
    this.sessionLedger =
      ledger ?? new SessionLedger(path.join(this.root, ".aios", "runtime", "sessions.json"));
    this.decisionLedger =
      decisionLedger ?? new RoutingDecisionLedger(routingDecisionsPath(this.root));
    this.store = store ?? new TaskStore(this.root);
  }

  async policyRevision() {
    const loaded = await loadExecutionConfig(this.configPath);
    return loaded.kind === "routing" ? routingPolicyRevision(loaded.config) : null;
  }

  async resolve(role, context) {
    if (!ROUTED_ROLES.has(role)) {
      throw new WorkerError(`Role ${role} is outside adaptive model routing`);
    }
    if (
      context === null ||
      typeof context !== "object" ||
      context.task?.metadata?.id === undefined ||
      context.role !== role ||
      !Object.isFrozen(context) ||
      !Number.isSafeInteger(context.attempt) ||
      context.attempt !== context.task.metadata.retry.count + 1 ||
      !Array.isArray(context.reviews) ||
      !Object.isFrozen(context.reviews) ||
      context.runOptions === null ||
      typeof context.runOptions !== "object" ||
      !Object.isFrozen(context.runOptions) ||
      (context.routingPolicyRevision !== null &&
        typeof context.routingPolicyRevision !== "string")
    ) {
      throw new WorkerError("Routed assignment requires an immutable dispatch context");
    }
    const loaded = await loadExecutionConfig(this.configPath);
    if (loaded.kind !== "routing") {
      throw new WorkerError("Expected an aios.routing/v1 execution configuration");
    }
    const revision = routingPolicyRevision(loaded.config);
    if (
      context.routingPolicyRevision !== null &&
      context.routingPolicyRevision !== revision
    ) {
      throw new WorkerError("Routing policy changed while preparing dispatch context");
    }
    const sessionState = await this.sessionLedger.load();
    const workload = await buildWorkloadContext({
      task: context.task,
      role,
      root: this.root,
      config: loaded.config,
      reviews: context.reviews,
      sessions: sessionState.sessions,
      store: this.store,
    });
    const key = {
      task: context.task.metadata.id,
      role,
      attempt: context.attempt,
      policy_revision: revision,
    };
    let snapshot = await this.decisionLedger.load();
    const existing = await this.decisionLedger.resolveKey(key);
    let selection;
    if (existing === null) {
      const implementerDecision = implementerDecisionFor(snapshot.decisions, key);
      selection = selectCandidate({
        config: loaded.config,
        workload,
        key,
        history: historyProjection(snapshot.decisions),
        implementerDecision,
      });
      const timestamp = new Date().toISOString();
      snapshot = await this.decisionLedger.record(
        snapshot,
        decisionRecordFromSelection(selection, { recorded_at: timestamp }),
      );
    } else {
      if (existing.active.status !== "selected") {
        throw new WorkerError(
          `Routing decision ${existing.key_string} is already ${existing.active.status} and cannot be relaunched safely`,
        );
      }
      selection = {
        ...existing.active,
        key_string: existing.key_string,
      };
    }
    return new RoutedWorker({
      root: this.root,
      configPath: this.configPath,
      config: loaded.config,
      revision,
      workload,
      key,
      selection,
      decisionLedger: this.decisionLedger,
      sessionLedger: this.sessionLedger,
      store: this.store,
      timeoutMs: this.timeoutMs,
    });
  }
}
