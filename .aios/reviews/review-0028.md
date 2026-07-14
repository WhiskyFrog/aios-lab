---
schema: aios.review/v1
id: review-0028
project: aios-lab
task: task-0021
attempt: 3
verdict: changes_requested
---

# Review of task-0021, Attempt 3

## Findings

Three acceptance-blocking defects remain:
1. src/progression.js stops scanning at the first non-done Task, so completed contains only the done prefix. Consequently src/dashboard.js reports an incorrect done count and labels later done Tasks as upcoming. Derive completion for every ordered Task while retaining the first non-done Task as current, and add an interleaved unfinished/done regression test.
2. src/plan-dashboard.js matches session evidence only by Task and filters failures before selecting the newest row. It can display another Role's failure or an older failure despite a newer completed row. Derive the current Role from the live Task state, select the newest row for that exact Task/Role regardless of outcome, and render it only if that newest row is failed or capacity_deferred. Add mixed-Role and newer-completed tests.
3. collectPlanProgress constructs the plan path from unvalidated PLAN.md metadata.id instead of the discovered directory name. A mismatched or path-like id can inspect the wrong directory and fail to name the actual plan. Preserve the discovered directory identity, use it for core derivation, validate metadata.id against that directory, render a named error card without aborting other plans, and add mismatch/path-like regression coverage.
