import {
  ContractError,
  currentAttempt,
  roleForState,
  validateResult,
} from "./contracts.js";
import { setTimeout as timerSleep } from "node:timers/promises";
import {
  StoreError,
  TaskConflictError,
  TaskStore,
  appendAttempt,
  repeatsAttemptEvidence,
} from "./documents.js";
import { CapacityDeferredError } from "./workers.js";

const DEFAULT_MAX_CAPACITY_WAIT_MS = 604_800_000;
const DEFAULT_MAX_CAPACITY_PAUSES = 8;

function defaultSleep(ms, { signal } = {}) {
  return timerSleep(ms, undefined, { signal });
}

function halted(task, reason, category) {
  return { kind: "halted", task, reason, category };
}

function haltedDocument(task, reason) {
  return halted(task, reason, "invalid_document");
}

function haltedConflict(task, reason) {
  return halted(task, reason, "conflict");
}

function haltedCancelled(task, reason) {
  return halted(task, reason, "cancelled");
}

function haltedWorker(task, reason) {
  return halted(task, reason, "worker_failure");
}

// approval_gate is reserved for the approver Role's own explicit failure
// Result (no decision file yet, or an invalid one); every other failure that
// happens to occur while dispatching to the approver Role — a missing
// Assignment, an execution error, a capacity failure, or a malformed Result —
// is still a worker_failure.
function haltedApproverGate(task, reason) {
  return halted(task, reason, "approval_gate");
}

function isCancellation(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function runOptionsError(options) {
  if (typeof options.waitForCapacity !== "boolean") {
    return "waitForCapacity must be a boolean";
  }
  if (!isPositiveInteger(options.maxCapacityWaitMs)) {
    return "maxCapacityWaitMs must be a positive integer";
  }
  if (!isPositiveInteger(options.maxCapacityPauses)) {
    return "maxCapacityPauses must be a positive integer";
  }
  return null;
}

function taskChangedWhileExecuting(task) {
  return haltedConflict(
    task,
    "Task changed while the Worker was executing; the engine did not overwrite it",
  );
}

function taskChangedWhileWaiting(task) {
  return haltedConflict(
    task,
    "Task changed while waiting for Worker capacity; the engine did not resume it",
  );
}

function capacityPause(error, now) {
  if (
    typeof error.retryAt !== "string" ||
    error.retryAt.length === 0 ||
    typeof error.continuation !== "string" ||
    error.continuation.trim().length === 0
  ) {
    return null;
  }
  const retryAtMs = Date.parse(error.retryAt);
  if (!Number.isFinite(retryAtMs) || retryAtMs <= now) {
    return null;
  }
  return {
    continuation: error.continuation,
    delayMs: retryAtMs - now,
    retryAt: new Date(retryAtMs).toISOString(),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function transitionFromReview(task, review) {
  const metadata = structuredClone(task.metadata);
  metadata.last_review = review.metadata.id;

  if (review.metadata.verdict === "pass") {
    metadata.state = metadata.approval === "required" ? "approval" : "done";
    return metadata;
  }

  if (metadata.retry.count < metadata.retry.limit) {
    metadata.retry.count += 1;
    metadata.state = "implement";
  } else {
    metadata.state = "blocked";
  }
  return metadata;
}

export class LoopEngine {
  constructor({
    root,
    assignments,
    store = null,
    clock = () => Date.now(),
    sleep = defaultSleep,
  }) {
    this.store = store ?? new TaskStore(root);
    this.assignments = assignments;
    this.clock = clock;
    this.sleep = sleep;
  }

  async run(taskId, {
    waitForCapacity = false,
    maxCapacityWaitMs = DEFAULT_MAX_CAPACITY_WAIT_MS,
    maxCapacityPauses = DEFAULT_MAX_CAPACITY_PAUSES,
    signal = undefined,
  } = {}) {
    let task = null;
    const options = { waitForCapacity, maxCapacityWaitMs, maxCapacityPauses };
    const optionError = runOptionsError(options);
    if (optionError !== null) {
      return halted(task, `Invalid capacity wait option: ${optionError}`, "worker_failure");
    }
    let capacityPauses = 0;
    let requestedCapacityWaitMs = 0;

    while (true) {
      try {
        task = await this.store.loadTask(taskId);
        await this.store.validateTaskEvidence(task);
      } catch (error) {
        return haltedDocument(task, error.message);
      }

      if (task.metadata.state === "done" || task.metadata.state === "blocked") {
        return { kind: task.metadata.state, task };
      }

      const role = roleForState(task.metadata.state);
      if (role === null) {
        return haltedDocument(task, `Task state ${task.metadata.state} has no Role`);
      }

      if (role === "reviewer") {
        let currentReviews;
        try {
          currentReviews = await this.store.findReviews(
            task.metadata.id,
            currentAttempt(task.metadata),
          );
        } catch (error) {
          return haltedDocument(task, error.message);
        }
        if (currentReviews.length > 1) {
          return haltedDocument(
            task,
            `Multiple Reviews exist for (${task.metadata.id}, attempt ${currentAttempt(
              task.metadata,
            )})`,
          );
        }
        if (currentReviews.length === 1) {
          const orphan = currentReviews[0];
          if (orphan.metadata.project !== task.metadata.project) {
            return haltedDocument(task, "Orphan Review does not match the active Task's project");
          }
          try {
            await this.store.writeTask(
              task,
              transitionFromReview(task, orphan),
            );
          } catch (error) {
            const reason = `Unable to attach orphan Review: ${error.message}`;
            return error instanceof TaskConflictError
              ? haltedConflict(task, reason)
              : haltedDocument(task, reason);
          }
          continue;
        }
      }

      let worker;
      try {
        worker = await this.assignments.resolve(role);
      } catch (error) {
        return haltedWorker(task, error.message);
      }

      let rawResult;
      let continuation = null;

      while (true) {
        let executionError = null;
        try {
          rawResult = await worker.execute(task, { continuation, signal });
        } catch (error) {
          executionError = error;
        }

        if (!(await this.store.taskIsUnchanged(task))) {
          return taskChangedWhileExecuting(task);
        }
        if (!(executionError instanceof CapacityDeferredError)) {
          if (executionError !== null) {
            return isCancellation(executionError, signal)
              ? haltedCancelled(task, executionError.message)
              : haltedWorker(task, executionError.message);
          }
          break;
        }

        let now;
        try {
          now = Number(this.clock());
        } catch (error) {
          return haltedWorker(
            task,
            `Unable to read the capacity wait clock: ${errorMessage(error)}`,
          );
        }
        const pause = Number.isFinite(now) ? capacityPause(executionError, now) : null;
        if (pause === null) {
          return haltedWorker(task, "Worker returned a stale or malformed capacity reset");
        }

        if (!waitForCapacity) {
          return {
            kind: "waiting",
            task,
            reason: executionError.message,
            retryAt: pause.retryAt,
          };
        }

        capacityPauses += 1;
        if (capacityPauses > maxCapacityPauses) {
          return haltedWorker(
            task,
            `Worker capacity pause limit exceeded (${maxCapacityPauses})`,
          );
        }
        requestedCapacityWaitMs += pause.delayMs;
        if (requestedCapacityWaitMs > maxCapacityWaitMs) {
          return haltedWorker(
            task,
            `Worker capacity wait limit exceeded (${maxCapacityWaitMs} ms)`,
          );
        }

        let sleepError = null;
        try {
          await this.sleep(pause.delayMs, { signal });
        } catch (error) {
          sleepError = error;
        }
        if (!(await this.store.taskIsUnchanged(task))) {
          return taskChangedWhileWaiting(task);
        }
        if (sleepError !== null) {
          return isCancellation(sleepError, signal)
            ? haltedCancelled(task, "Worker capacity wait was cancelled")
            : haltedWorker(task, `Worker capacity wait failed: ${errorMessage(sleepError)}`);
        }
        continuation = pause.continuation;
      }

      let result;
      try {
        result = validateResult(rawResult, task.metadata, role);
      } catch (error) {
        const reason =
          error instanceof ContractError ? error.message : `Invalid Result: ${error.message}`;
        return haltedWorker(task, reason);
      }

      if (result.status === "failure") {
        return role === "approver"
          ? haltedApproverGate(task, result.payload.reason)
          : haltedWorker(task, result.payload.reason);
      }

      if (role === "implementer") {
        const previousAttempt = currentAttempt(task.metadata) - 1;
        if (
          previousAttempt > 0 &&
          repeatsAttemptEvidence(
            task.body,
            previousAttempt,
            result.payload.summary,
            result.payload.verification,
          )
        ) {
          return haltedWorker(
            task,
            `Implementer repeated the evidence from Attempt ${previousAttempt}; ` +
              "submit evidence that describes the actual correction before retrying",
          );
        }
        const metadata = structuredClone(task.metadata);
        metadata.state = "review";
        let body;
        try {
          body = appendAttempt(
            task.body,
            currentAttempt(task.metadata),
            result.payload.summary,
            result.payload.verification,
          );
          await this.store.writeTask(task, metadata, body);
        } catch (error) {
          const reason = `Unable to persist Implementer Result: ${error.message}`;
          return error instanceof TaskConflictError
            ? haltedConflict(task, reason)
            : haltedDocument(task, reason);
        }
        continue;
      }

      if (role === "reviewer") {
        let review;
        try {
          review = await this.store.createReview(task, result.payload);
        } catch (error) {
          return haltedDocument(task, `Unable to persist Review: ${error.message}`);
        }
        try {
          await this.store.writeTask(task, transitionFromReview(task, review));
        } catch (error) {
          const prefix =
            error instanceof TaskConflictError
              ? "Review persisted as an orphan after a Task conflict"
              : "Review persisted but Task transition failed";
          const reason = `${prefix}: ${error.message}`;
          return error instanceof TaskConflictError
            ? haltedConflict(task, reason)
            : haltedDocument(task, reason);
        }
        continue;
      }

      const metadata = structuredClone(task.metadata);
      if (result.payload.decision === "approved") {
        metadata.approval = "approved";
        metadata.state = "done";
      } else {
        metadata.approval = "rejected";
        metadata.state = "blocked";
      }
      try {
        await this.store.writeTask(task, metadata);
      } catch (error) {
        const reason = error instanceof StoreError ? error.message : String(error);
        const message = `Unable to persist approval decision: ${reason}`;
        return error instanceof TaskConflictError
          ? haltedConflict(task, message)
          : haltedDocument(task, message);
      }
    }
  }
}
