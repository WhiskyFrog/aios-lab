---
schema: aios.review/v1
id: review-0021
project: aios-lab
task: task-0019
attempt: 1
verdict: changes_requested
---

# Review of task-0019, Attempt 1

## Findings

Two acceptance-blocking defects remain:
1. src/engine.js classifies every approver-side halt as approval_gate. Missing assignments, execution errors/timeouts, malformed Results, and capacity failures are not approval gates; approval_gate is limited to a valid approver failure Result caused by a missing or invalid decision file. Classify genuine approver/dispatch failures as worker_failure (or cancelled where applicable), reserving approval_gate for the decision-file gate. The progression awaiting-approval fixture currently masks this bug by omitting the approver assignment; replace it with a real or faithful human-approver decision-file fixture and add coverage proving an approver execution/assignment failure is not an approval gate.
2. runProgression does not append a Task to an in-call completed list after engine.run returns done. It rescans repository state instead, so if done is not immediately reflected or the Task changes again during the call, the same Task can be passed to engine.run more than once, violating the explicit at-most-once-per-Task contract. Track completed/invoked Tasks within the call and advance strictly forward after done. Add the required idempotent reinvocation test with an already-done prefix and assertions that completed Tasks are never passed to the engine; the current idempotence test has no completed Task and does not verify this criterion.
