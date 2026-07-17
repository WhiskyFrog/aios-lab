---
schema: aios.review/v1
id: review-0058
project: aios-lab
task: task-0041
attempt: 1
verdict: changes_requested
---

# Review of task-0041, Attempt 1

## Findings

distributionHistoryDecisions does not determine closure exactly by append position. It infers reset ordering with reset.observed_at <= the later row's recorded_at, but the ledger permits equal timestamps. If unrelated row B is selected while generation A is open, B is recorded at T, and resetAction resets A at the same T, resetAction's validation incorrectly treats A as already closed at B's position and rejects B's previously valid distribution. Reversing the comparison would break a fresh post-reset row recorded at T, so the ambiguous ordering must be resolved without timestamp-only inference and covered by a regression. Also, historical replay requires reset events even though the existing closed-generation definition is simply that every current-generation row is superseded; a generation closed through the public updateOutcome(..., status: 'superseded') path is filtered at selection time but retained during replay, recreating the mismatch. Preserve the exact existing all-superseded definition at both sites. Non-blocking verification note: the relevant test suites could not execute in this reviewer sandbox because /tmp is read-only (EROFS).
