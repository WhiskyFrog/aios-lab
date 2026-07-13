---
schema: aios.review/v1
id: review-0014
project: aios-lab
task: task-0013
attempt: 1
verdict: pass
---

# Review of task-0013, Attempt 1

## Findings

The implementation satisfies the Task without changing the engine or v1
contracts. `workers/codex-capacity.mjs` invokes the same launcher with
`app-server --stdio`, performs initialize/initialized ordering, requests the
exact thread with only its newest turn and no item data, and independently
reads account rate limits. Its pure selector requires a failed latest turn with
the exact `usageLimitExceeded` code, a recognized reached type, an exhausted
Codex window, and a finite future reset for every exhausted window. It ignores
all human-readable messages and chooses the maximum reset when both windows
block. Any missing or malformed evidence returns null or rejects the probe;
`workers/codex-worker.mjs` logs that diagnostic and preserves the ordinary
failure. A valid deferral uses the public thread id for both session identity
and continuation, while the existing resume identity check remains ahead of
deferral construction. The fixture never invokes account reset-credit methods.
Focused tests exercise the real handshake shape, negative evidence cases,
multi-window timing, probe unavailability, and a deferral followed by exact-id
completion. The installed app-server accepted the bounded thread request and
returned structured account windows in a read-only runtime check. The full
suite passes 123/123 and `git diff --check` is clean.
