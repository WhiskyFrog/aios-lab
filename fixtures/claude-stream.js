import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];

if (mode === "defer-tree") {
  const descendant = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  writeFileSync(process.argv[3], String(descendant.pid), "utf8");
  const sessionId = "fixture-capacity-session";
  process.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "fixture-model",
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "rate_limit_event",
      session_id: sessionId,
      rate_limit_info: {
        status: "rejected",
        utilization: 1,
        resetsAt: 2_000_000_000,
      },
    })}\n`,
  );
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write(`unknown Claude stream fixture mode: ${String(mode)}`);
  process.exitCode = 8;
}
