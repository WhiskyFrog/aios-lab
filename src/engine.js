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
} from "./documents.js";
import { CapacityDeferredError } from "./workers.js";

const DEFAULT_MAX_CAPACITY_WAIT_MS = 604_800_000;
const DEFAULT_MAX_CAPACITY_PAUSES = 8;

function defaultSleep(ms, { signal } = {}) {
  return timerSleep(ms, undefined, { signal });
}

function halted(task, reason) {
  return { kind: "halted", task, reason };
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
  return halted(
    task,
    "Task changed while the Worker was executing; the engine did not overwrite it",
  );
}

function taskChangedWhileWaiting(task) {
  return halted(
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
      return halted(task, `Invalid capacity wait option: ${optionError}`);
    }
    let capacityPauses = 0;
    let requestedCapacityWaitMs = 0;

    while (true) {
      try {
        task = await this.store.loadTask(taskId);
        await this.store.validateTaskEvidence(task);
      } catch (error) {
        return halted(task, error.message);
      }

      if (task.metadata.state === "done" || task.metadata.state === "blocked") {
        return { kind: task.metadata.state, task };
      }

      const role = roleForState(task.metadata.state);
      if (role === null) {
        return halted(task, `Task state ${task.metadata.state} has no Role`);
      }

      if (role === "reviewer") {
        let currentReviews;
        try {
          currentReviews = await this.store.findReviews(
            task.metadata.id,
            currentAttempt(task.metadata),
          );
        } catch (error) {
          return halted(task, error.message);
        }
        if (currentReviews.length > 1) {
          return halted(
            task,
            `Multiple Reviews exist for (${task.metadata.id}, attempt ${currentAttempt(
              task.metadata,
            )})`,
          );
        }
        if (currentReviews.length === 1) {
          const orphan = currentReviews[0];
          if (orphan.metadata.project !== task.metadata.project) {
            return halted(task, "Orphan Review does not match the active Task's project");
          }
          try {
            await this.store.writeTask(
              task,
              transitionFromReview(task, orphan),
            );
          } catch (error) {
            return halted(task, `Unable to attach orphan Review: ${error.message}`);
          }
          continue;
        }
      }

      let worker;
      try {
        worker = await this.assignments.resolve(role);
      } catch (error) {
        return halted(task, error.message);
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
            return halted(task, executionError.message);
          }
          break;
        }

        let now;
        try {
          now = Number(this.clock());
        } catch (error) {
          return halted(task, `Unable to read the capacity wait clock: ${errorMessage(error)}`);
        }
        const pause = Number.isFinite(now) ? capacityPause(executionError, now) : null;
        if (pause === null) {
          return halted(task, "Worker returned a stale or malformed capacity reset");
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
          return halted(
            task,
            `Worker capacity pause limit exceeded (${maxCapacityPauses})`,
          );
        }
        requestedCapacityWaitMs += pause.delayMs;
        if (requestedCapacityWaitMs > maxCapacityWaitMs) {
          return halted(
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
          const cancelled = signal?.aborted === true || sleepError?.name === "AbortError";
          return halted(
            task,
            cancelled
              ? "Worker capacity wait was cancelled"
              : `Worker capacity wait failed: ${errorMessage(sleepError)}`,
          );
        }
        continuation = pause.continuation;
      }

      let result;
      try {
        result = validateResult(rawResult, task.metadata, role);
      } catch (error) {
        const reason =
          error instanceof ContractError ? error.message : `Invalid Result: ${error.message}`;
        return halted(task, reason);
      }

      if (result.status === "failure") {
        return halted(task, result.payload.reason);
      }

      if (role === "implementer") {
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
          return halted(task, `Unable to persist Implementer Result: ${error.message}`);
        }
        continue;
      }

      if (role === "reviewer") {
        let review;
        try {
          review = await this.store.createReview(task, result.payload);
        } catch (error) {
          return halted(task, `Unable to persist Review: ${error.message}`);
        }
        try {
          await this.store.writeTask(task, transitionFromReview(task, review));
        } catch (error) {
          const prefix =
            error instanceof TaskConflictError
              ? "Review persisted as an orphan after a Task conflict"
              : "Review persisted but Task transition failed";
          return halted(task, `${prefix}: ${error.message}`);
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
        return halted(task, `Unable to persist approval decision: ${reason}`);
      }
    }
  }
}
