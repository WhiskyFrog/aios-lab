---
schema: aios.review/v1
id: review-0036
project: aios-lab
task: task-0024
attempt: 2
verdict: changes_requested
---

# Review of task-0024, Attempt 2

## Findings

1. `planningContract` treats any Objective occurrence of `plans/<id>` as naming a plan output. A negative or inspection-only Objective can therefore be classified as planning when the other two patterns match, instead of becoming `unknown`. Require affirmative output evidence and add a regression test.
2. Parent discovery silently ignores partially adopted malformed plans: `collectPlanProposals` marks any PLAN containing a `P-##` placeholder as unadopted, so a hybrid PLAN that also names the Task is skipped. This produces only `parent_plan_missing`, which the lower-tier gate explicitly tolerates. Detect such malformed hybrid plans, record `parent_plan_invalid`, force the high tier, and test it.
3. Plan discovery is not fully deterministic because filesystem entries are processed in unspecified `readdir` order and `diagnostics.plan_errors` preserves that order. Sort discovered plans/errors before constructing the normalized context and add a stability test with multiple plan directories/errors.
