---
schema: aios.review/v1
id: review-0026
project: aios-lab
task: task-0021
attempt: 1
verdict: changes_requested
---

# Review of task-0021, Attempt 1

## Findings

Two acceptance-blocking defects remain:
1. `derivePlanProgressState` stops scanning at the first non-done Task, so `completed` contains only the done prefix. `renderPlanProgressCard` consequently reports the wrong done count and labels later already-done Tasks as `upcoming`. For an order `[task-0001 (implement), task-0002 (done)]`, it renders `0 / 2` instead of `1 / 2`. Core progression explicitly supports interleaved already-done Tasks. Extend the core derivation to expose actual completion status for every ordered Task while retaining the first non-done Task as current, render from that result, and add regression coverage.
2. `latestObservedSession` is not keyed by Task id and current Role: it matches only `session.task`. It can therefore show an old implementer failure while the Task is currently in review. It also filters to failure outcomes before choosing the newest row, allowing an older failure to be displayed even when a newer completed row exists for the same Task and Role. Determine the Role from the current live Task state, select the newest ledger row matching both Task and Role, and show it only when that selected row's outcome is `failed` or `capacity_deferred`. Add tests covering cross-Role rows and a newer completed row.
