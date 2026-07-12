import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputFile = outputIndex === -1 ? null : args[outputIndex + 1];
const mode = process.env.CODEX_FIXTURE_MODE ?? "success";

function write(text) {
  if (outputFile !== null) {
    writeFileSync(outputFile, text, "utf8");
  }
}

if (mode === "success") {
  const role = process.env.AIOS_ROLE;
  const payload =
    role === "implementer"
      ? { summary: "Implemented through Codex.", verification: "Ran the suite." }
      : role === "reviewer"
        ? { verdict: "pass", findings: "Codex review passes." }
        : { decision: "approved" };
  write(JSON.stringify(payload));
} else if (mode === "failure-reason") {
  write(JSON.stringify({ failure_reason: "codex could not proceed" }));
} else if (mode === "no-output") {
  // Leave outputFile unwritten to simulate a session that never produced one.
} else if (mode === "nonzero") {
  write(JSON.stringify({ summary: "should be ignored", verification: "n/a" }));
  process.exitCode = 3;
} else {
  process.stderr.write(`unknown codex fixture mode: ${mode}`);
  process.exitCode = 8;
}
