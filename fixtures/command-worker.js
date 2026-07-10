import process from "node:process";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
let taskDocument = "";

for await (const chunk of process.stdin) {
  taskDocument += chunk;
}

if (mode === "auto-loop") {
  const role = process.env.AIOS_ROLE;
  const payload =
    role === "implementer"
      ? {
          summary: "Implemented through the command adapter.",
          verification: "The end-to-end command completed.",
        }
      : role === "reviewer"
        ? { verdict: "pass", findings: "The command implementation passes." }
        : { decision: "approved" };
  process.stdout.write(
    JSON.stringify({
      schema: "aios.result/v1",
      task: process.env.AIOS_TASK_ID,
      role,
      status: "success",
      payload,
    }),
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
