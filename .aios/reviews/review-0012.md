---
schema: aios.review/v1
id: review-0012
project: aios-lab
task: task-0010
attempt: 1
verdict: changes_requested
---

# Review of task-0010, Attempt 1

## Findings

Everything checks out except one explicit Acceptance Criterion: "An end-to-end run in a disposable sandbox repository reaches `done` through Codex-backed Implementer and Reviewer sessions from one `aios run` invocation." The Attempt's own verification section states this was not achieved — the account hit a Codex usage-limit lockout across every accepted model, so only a partial sandbox run (halting on a nonzero `codex exec` exit) was demonstrated, not a run reaching `done`. That is an unmet, explicitly-worded AC, not a nitpick, so the Task cannot pass review on this Attempt regardless of cause. Please complete the full sandbox `aios run` to `done` via real Codex-backed Implementer and Reviewer sessions (rerun once quota resets, using a model the account accepts) and record that as verification.

Everything else inspected is solid and needs no change: `workers/worker-shared.mjs` correctly centralizes `rolePrompt`, `extractPayload`/`findMatchingBrace`, `validatePayload`, `WorkerFailure`/`fail`, and `readStdin`; the diff against the prior `workers/claude-worker.mjs` shows a pure extraction with no behavior change, and `npm test` passes 113/113 (98 pre-existing + 15 new), confirming the refactor didn't regress the Claude adapter. `workers/codex-worker.mjs` launches exactly one `codex exec` per Role with the correct sandbox mapping (`workspace-write` for implementer, `read-only` for reviewer/approver), never emits a `--dangerously-*` flag, resolves the launcher from trailing argv or `AIOS_CODEX_CLI`, passes `--model` only when `AIOS_CODEX_MODEL` is set, reads the reply from a temp `--output-last-message` file that's always cleaned up (`finally` + `rm`), and fails the adapter (nonzero exit, no stdout) on a nonzero exec exit, a missing final-message file, or an invalid/unparseable reply — matching `src/workers.js`'s `CommandWorker`, which resolves a non-`aios.worker-execution/v1` payload as a bare Result unchanged (workers.js:265-267). `src/` and `.aios/` are untouched apart from the engine-owned task document. The new README "Codex Workers" section covers the Assignment example, Windows shim caveat, sandbox mapping, and mixed-vendor example accurately.
