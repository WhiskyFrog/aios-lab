---
schema: aios.review/v1
id: review-0027
project: aios-lab
task: task-0021
attempt: 2
verdict: changes_requested
---

# Review of task-0021, Attempt 2

## Findings

Two acceptance-blocking defects remain. First, latestObservedSession ignores Role and filters to failure outcomes before determining recency. It can therefore display another Role's failure or an older failure even when the newest row for the current Task/Role is completed. Derive the live Role, select the newest ledger row for that exact Task/Role pair, and render it only when that newest row is failed or capacity_deferred; add mixed-role and newer-completed regression coverage. Second, collectPlanProgress constructs the plan path from unvalidated PLAN.md metadata.id rather than the discovered directory name. A mismatched or path-like id can make it inspect another directory and fail to name the actual plan directory. Preserve and use the discovered directory identity, validate the metadata/directory mismatch through the core derivation, and render a named error card without aborting other plans.
