// Fake routed provider Worker for adaptive-routing tests and the disposable
// demo. Argv declares the candidate identity explicitly:
//
//   node fixtures/routing-worker.js <provider> <model> <mode> [marker]
//
// It performs no network, credential, or paid provider call. Every structured
// mode emits a contract-valid aios.worker-execution/v1 envelope whose session
// telemetry carries the declared model id, so routing decisions and session
// ledger rows can be correlated in tests. The continuation token is bound to
// the candidate identity: any mode except capacity-once treats a received
// continuation as a foreign token that crossed candidates and refuses to run.
import process from "node:process";
import { existsSync, writeFileSync } from "node:fs";

const [provider, model, mode, marker] = process.argv.slice(2);
const task = process.env.AIOS_TASK_ID;
const role = process.env.AIOS_ROLE;
const receivedContinuation = process.env.AIOS_WORKER_CONTINUATION ?? null;
const sessionId = `${provider}-${model}-${task}-${role}`;
const boundContinuation = `continuation-${sessionId}`;

let taskDocument = "";
for await (const chunk of process.stdin) {
  taskDocument += chunk;
}
const attempts = [...taskDocument.matchAll(/^### Attempt /gm)].length;

function result(status, payload) {
  return { schema: "aios.result/v1", task, role, status, payload };
}

function successResult() {
  return result(
    "success",
    role === "reviewer"
      ? attempts <= 1 && mode === "review-cycle"
        ? {
            verdict: "changes_requested",
            findings: `Reviewed by ${model}: Attempt ${attempts} needs a stronger correction.`,
          }
        : {
            verdict: "pass",
            findings: `Reviewed by ${model}: the Attempt satisfies the Acceptance Criteria.`,
          }
      : {
          summary: `Implemented revision ${attempts + 1} with ${model}.`,
          verification: `Deterministic fake-provider verification for revision ${attempts + 1}.`,
        },
  );
}

function envelope({ resultValue = null, deferred = null }) {
  const now = new Date().toISOString();
  const outcome =
    deferred !== null
      ? "capacity_deferred"
      : resultValue.status === "failure"
        ? "failed"
        : "completed";
  return {
    schema: "aios.worker-execution/v1",
    result: resultValue,
    deferred,
    session: {
      id: sessionId,
      task,
      role,
      model,
      started_at: now,
      observed_at: now,
      outcome,
      usage:
        outcome === "capacity_deferred"
          ? null
          : {
              input_tokens: 128,
              output_tokens: 32,
              cache_creation_input_tokens: 8,
              cache_read_input_tokens: 16,
            },
      cost_usd: outcome === "capacity_deferred" ? null : 0,
      capacity:
        outcome === "capacity_deferred"
          ? {
              status: "rejected",
              utilization: 1,
              resets_at: deferred.retry_at,
            }
          : { status: "allowed", utilization: 0.1, resets_at: null },
    },
  };
}

function emit(value) {
  process.stdout.write(JSON.stringify(value));
}

if (mode !== "capacity-once" && receivedContinuation !== null) {
  process.stderr.write(
    `foreign continuation ${receivedContinuation} crossed into candidate session ${sessionId}`,
  );
  process.exitCode = 9;
} else if (mode === "complete" || mode === "review-cycle") {
  emit(envelope({ resultValue: successResult() }));
} else if (mode === "repeat-evidence") {
  emit(
    envelope({
      resultValue: result("success", {
        summary: "Repeated fixture evidence.",
        verification: "Repeated fixture verification.",
      }),
    }),
  );
} else if (mode === "verification-failure" || mode === "context-failure") {
  emit(
    envelope({
      resultValue: result("failure", {
        reason:
          mode === "verification-failure"
            ? `Objective verification failed under ${model}.`
            : `The available context is insufficient for ${model}.`,
        failure_kind:
          mode === "verification-failure"
            ? "verification_failed"
            : "context_insufficient",
      }),
    }),
  );
} else if (mode === "capacity-once") {
  const roleMarker = `${marker}.${role}`;
  if (!existsSync(roleMarker)) {
    writeFileSync(roleMarker, "deferred", "utf8");
    emit(
      envelope({
        deferred: {
          kind: "capacity",
          retry_at: new Date(Date.now() + 200).toISOString(),
          continuation: boundContinuation,
        },
      }),
    );
  } else if (receivedContinuation !== boundContinuation) {
    process.stderr.write(
      `expected candidate-bound continuation ${boundContinuation}, got ${String(receivedContinuation)}`,
    );
    process.exitCode = 9;
  } else {
    emit(envelope({ resultValue: successResult() }));
  }
} else if (mode === "capacity-always") {
  emit(
    envelope({
      deferred: {
        kind: "capacity",
        retry_at: new Date(Date.now() + 120_000).toISOString(),
        continuation: boundContinuation,
      },
    }),
  );
} else if (mode === "timeout") {
  setInterval(() => {}, 1_000);
} else if (mode === "provider-failure") {
  process.stderr.write(`fake ${provider} provider failure from ${model}`);
  process.exitCode = 7;
} else {
  process.stderr.write(`unknown routing-worker mode: ${String(mode)}`);
  process.exitCode = 8;
}
