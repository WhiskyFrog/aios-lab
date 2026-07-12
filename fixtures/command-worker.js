import process from "node:process";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";

const mode = process.argv[2];
let taskDocument = "";

for await (const chunk of process.stdin) {
  taskDocument += chunk;
}

function rolePayload(role) {
  return role === "implementer"
    ? {
        summary: "Implemented through the command adapter.",
        verification: "The end-to-end command completed.",
      }
    : role === "reviewer"
      ? { verdict: "pass", findings: "The command implementation passes." }
      : { decision: "approved" };
}

function result(role) {
  return {
    schema: "aios.result/v1",
    task: process.env.AIOS_TASK_ID,
    role,
    status: "success",
    payload: rolePayload(role),
  };
}

function session(role, id, outcome, capacity) {
  const now = new Date().toISOString();
  return {
    id,
    task: process.env.AIOS_TASK_ID,
    role,
    model: "fixture-model",
    started_at: now,
    observed_at: now,
    outcome,
    usage:
      outcome === "capacity_deferred"
        ? null
        : {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
    cost_usd: outcome === "capacity_deferred" ? null : 0.001,
    capacity,
  };
}

function workerExecution({
  role,
  id,
  resultValue = null,
  deferred = null,
  capacity,
  outcome = null,
}) {
  return {
    schema: "aios.worker-execution/v1",
    result: resultValue,
    deferred,
    session: session(
      role,
      id,
      outcome ?? (deferred === null ? "completed" : "capacity_deferred"),
      capacity,
    ),
  };
}

if (mode === "auto-loop") {
  const role = process.env.AIOS_ROLE;
  process.stdout.write(JSON.stringify(result(role)));
} else if (mode === "deferred") {
  const role = process.env.AIOS_ROLE;
  const id = `fixture-${role}`;
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  process.stdout.write(
    JSON.stringify(
      workerExecution({
        role,
        id,
        deferred: { kind: "capacity", retry_at: retryAt, continuation: id },
        capacity: { status: "rejected", utilization: 1, resets_at: retryAt },
      }),
    ),
  );
} else if (mode === "capacity-loop") {
  const role = process.env.AIOS_ROLE;
  const id = `fixture-${role}`;
  const marker = `${process.argv[3]}.${role}`;
  if (!existsSync(marker)) {
    writeFileSync(marker, "deferred", "utf8");
    const retryAt = new Date(Date.now() + 100).toISOString();
    process.stdout.write(
      JSON.stringify(
        workerExecution({
          role,
          id,
          deferred: { kind: "capacity", retry_at: retryAt, continuation: id },
          capacity: { status: "rejected", utilization: 1, resets_at: retryAt },
        }),
      ),
    );
  } else if (process.env.AIOS_WORKER_CONTINUATION !== id) {
    process.stderr.write("missing exact continuation");
    process.exitCode = 9;
  } else {
    process.stdout.write(
      JSON.stringify(
        workerExecution({
          role,
          id,
          resultValue: result(role),
          capacity: { status: "allowed", utilization: 0.1, resets_at: null },
        }),
      ),
    );
  }
} else if (mode === "execution-mismatch") {
  const role = process.env.AIOS_ROLE;
  const execution = workerExecution({
    role,
    id: `fixture-${role}`,
    resultValue: result(role),
    capacity: null,
  });
  execution.session.task = "task-wrong";
  process.stdout.write(JSON.stringify(execution));
} else if (mode === "execution-failure") {
  const role = process.env.AIOS_ROLE;
  process.stdout.write(
    JSON.stringify(
      workerExecution({
        role,
        id: `fixture-${role}`,
        resultValue: {
          schema: "aios.result/v1",
          task: process.env.AIOS_TASK_ID,
          role,
          status: "failure",
          payload: { reason: "structured fixture failure" },
        },
        capacity: null,
        outcome: "failed",
      }),
    ),
  );
} else if (mode === "success") {
  process.stdout.write(
    JSON.stringify({
      schema: "aios.result/v1",
      task: process.env.AIOS_TASK_ID,
      role: process.env.AIOS_ROLE,
      status: "success",
      payload: {
        summary: taskDocument.includes("## Objective")
          ? "Received the complete Task document."
          : "Task document was incomplete.",
        verification: "Command fixture completed.",
      },
    }),
  );
} else if (mode === "nonzero") {
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "malformed") {
  process.stdout.write('{"schema":"aios.result/v1"}\nnot-json');
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "hang-tree") {
  const descendant = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  writeFileSync(process.argv[3], String(descendant.pid), "utf8");
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write(`unknown fixture mode: ${String(mode)}`);
  process.exitCode = 8;
}
