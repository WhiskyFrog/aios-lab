---
schema: aios.review/v1
id: review-0002
project: aios-lab
task: task-0002
attempt: 1
verdict: changes_requested
---

# Review of task-0002, Attempt 1

## Findings

1. `.aios/results/README.md` labels all success payload snippets as JSON, but
   the reviewer and approver snippets use `|` alternatives and fail JSON
   parsing. Replace them in the next implementation with valid JSON examples
   or unambiguous schema notation.
2. `.aios/reviews/README.md` declares Reviews immutable and permits at most one
   Review per `(task, attempt)`, while `aios.task/v1` says an orphaned Review is
   recoverable. No recovery rule says how a resumed engine discovers and
   attaches an orphan before re-invoking the Reviewer. Define deterministic
   recovery and conflict handling.
3. The sentence saying a wrong persisted verdict is corrected by the next
   evaluation conflicts with the at-most-one Review rule for `(task, attempt)`,
   and a passing verdict may make the Task terminal. Clarify that policy
   without adding speculative supersession machinery.
