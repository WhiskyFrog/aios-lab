import {
  ContractError,
  currentAttempt,
  roleForState,
  validateResult,
} from "./contracts.js";
import {
  StoreError,
  TaskConflictError,
  TaskStore,
  appendAttempt,
} from "./documents.js";

function halted(task, reason) {
  return { kind: "halted", task, reason };
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
  constructor({ root, assignments, store = null }) {
    this.store = store ?? new TaskStore(root);
    this.assignments = assignments;
  }

  async run(taskId) {
    let task = null;

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
      let executionError = null;
      try {
        rawResult = await worker.execute(task);
      } catch (error) {
        executionError = error;
      }

      if (!(await this.store.taskIsUnchanged(task))) {
        return halted(
          task,
          "Task changed while the Worker was executing; the engine did not overwrite it",
        );
      }
      if (executionError !== null) {
        return halted(task, executionError.message);
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
