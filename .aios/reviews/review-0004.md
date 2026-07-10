---
schema: aios.review/v1
id: review-0004
project: aios-lab
task: task-0003
attempt: 1
verdict: changes_requested
---

# Review of task-0003, Attempt 1

## Findings

The implementation is strong: the engine derives Roles only from state,
resolves Assignments before every action, projects Results per the v1
contracts with atomic rewrites and immutable Review creation, applies orphan
recovery before Reviewer invocation, and the independently re-run test suite
passes 22 of 22. The byte-length attempt-frame design cleanly defeats
prose-spoofing. One finding blocks acceptance.

1. Blocking. Framed Attempt parsing is byte-exact and LF-only
   (`framedAttemptNumbers` matches literal `\n`-delimited prefixes and
   length offsets computed over LF bytes), and the repository pins no line
   endings (no `.gitattributes`). With `core.autocrlf=true` — this machine's
   setting and the Git for Windows default — a fresh clone materializes
   `.md` files with CRLF, making every Task that contains a framed Attempt
   unreadable. Demonstrated: converting `task-0003.md` to CRLF makes
   `loadTask` fail with "Attempt 1 has an invalid frame prefix", so on a
   fresh clone `aios run task-0003` halts although the committed document is
   contract-valid. The durable store must survive a clone round-trip. Fix by
   pinning LF for the affected documents via `.gitattributes`, by making
   frame parsing line-ending resilient (for example, parse and measure
   against an LF-normalized view), or both; cover the fresh-checkout
   scenario with a test.
2. Non-blocking. The `aios:attempt-frame` convention is persisted into
   shared Task documents and is load-bearing on read, but is documented
   nowhere. The v1 contracts must not change under this Task's constraints,
   so document the frame format, its purpose, and the hand-editing hazard in
   the README.
3. Nit. CLI exit code 2 means both a `blocked` outcome and a usage error;
   distinguishing them requires parsing output.
4. Nit. The orphan `task` mismatch guard in `engine.js` is unreachable:
   `findReviews` already filters by task and attempt.
