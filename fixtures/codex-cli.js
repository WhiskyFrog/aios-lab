import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = process.env.CODEX_FIXTURE_MODE ?? "success";

function emitProtocol(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runAppServerFixture() {
  const appMode = process.env.CODEX_FIXTURE_APP_SERVER_MODE ?? "normal";
  if (appMode === "unavailable") {
    process.exitCode = 9;
    return;
  }
  if (appMode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const request = JSON.parse(line);
    if (request.id === 1 && request.method === "initialize") {
      emitProtocol({ id: 1, result: {} });
    } else if (request.id === 2 && request.method === "thread/resume") {
      const errorInfo =
        appMode === "wrong-error" || mode !== "usage-limit"
          ? "internalServerError"
          : "usageLimitExceeded";
      emitProtocol({
        id: 2,
        result: {
          thread: { id: request.params.threadId },
          initialTurnsPage: {
            data: [
              {
                id: "turn-fixture",
                status: "failed",
                items: [],
                error: {
                  message: "fixture message must not be parsed",
                  codexErrorInfo: errorInfo,
                },
              },
            ],
          },
        },
      });
    } else if (request.id === 3 && request.method === "account/rateLimits/read") {
      const reset = Number(process.env.CODEX_FIXTURE_RESETS_AT ?? 2_000_000_000);
      const exhausted = mode === "usage-limit";
      emitProtocol({
        id: 3,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: exhausted ? 100 : 20,
              resetsAt: appMode === "no-reset" ? null : reset,
            },
            secondary: null,
            rateLimitReachedType: exhausted ? "rate_limit_reached" : null,
          },
        },
      });
    }
  }
}

if (args[0] === "app-server") {
  await runAppServerFixture();
  process.exit();
}

const outputIndex = args.indexOf("--output-last-message");
const outputFile = outputIndex === -1 ? null : args[outputIndex + 1];
const resumeIndex = args.indexOf("resume");
const threadId =
  resumeIndex === -1 ? "019f0000-0000-7000-8000-000000000001" : args[resumeIndex + 1];

function write(text) {
  if (outputFile !== null) {
    writeFileSync(outputFile, text, "utf8");
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (mode === "success") {
  const role = process.env.AIOS_ROLE;
  const payload =
    role === "implementer"
      ? { summary: "Implemented through Codex.", verification: "Ran the suite." }
      : role === "reviewer"
        ? { verdict: "pass", findings: "Codex review passes." }
        : { decision: "approved" };
  write(JSON.stringify(payload));
  emit({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify(payload) } });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    },
  });
} else if (mode === "failure-reason") {
  const payload = { failure_reason: "codex could not proceed" };
  write(JSON.stringify(payload));
  emit({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify(payload) } });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 4 },
  });
} else if (mode === "no-output") {
  // Leave outputFile unwritten to simulate a session that never produced one.
  emit({
    type: "turn.completed",
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 0 },
  });
} else if (mode === "nonzero") {
  write(JSON.stringify({ summary: "should be ignored", verification: "n/a" }));
  emit({ type: "error", message: "synthetic Codex failure" });
  emit({ type: "turn.failed", error: { message: "synthetic Codex failure" } });
  process.exitCode = 3;
} else if (mode === "usage-limit") {
  const message =
    "You've hit your usage limit.\nTo get more access now, send a request to your admin or try again at 12:16 PM.";
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exitCode = 1;
} else {
  process.stderr.write(`unknown codex fixture mode: ${mode}`);
  process.exitCode = 8;
}
