---
schema: aios.review/v1
id: review-0061
project: aios-lab
task: task-0042
attempt: 1
verdict: changes_requested
---

# Review of task-0042, Attempt 1

## Findings

AC 'Every existing test in test/routing-ledger.test.js and test/routing-reset.test.js continues to pass unmodified, including its existing changed-policy-revision reset-then-reselect coverage, demonstrating the correction is additive to the same-policy case and not a behavior change to the already-covered changed-policy case' is not met. The pre-existing test 'resetAction supersedes every row and unblocks a fresh same-key selection under a new revision' (committed at HEAD 90cfb61, test/routing-reset.test.js:227) was itself edited in this Attempt's working tree: its fresh selection's `history` argument was changed from `[decoyHistoryRow(selection)]` to `historyProjection(afterReset.decisions)` (test/routing-reset.test.js diff, around line 265). I verified this is not a cosmetic change: restoring only that one line to its committed decoy-row form, while keeping the rest of the working tree (including the src/routing-ledger.js and src/routing-dispatch.js fix) as-is, makes the test fail with 'Routing decision 1.distribution.observed: must equal the actual preceding ledger window' — the same class of error the src/routing-dispatch.js historyProjection change (switching from currentGenerationDecisions to distributionHistoryDecisions) introduces. So the already-covered changed-policy-revision case required a real behavior-relevant test edit to keep passing, directly contradicting the Attempt's own claim ('I verified rather than re-implemented this... no source changes were needed') and the AC's explicit 'not a behavior change to the already-covered changed-policy case' requirement. Either the historyProjection/distribution-window change needs to be scoped so the previously-committed test passes unmodified, or the Task's AC and Attempt narrative need to honestly acknowledge that the fix does change the changed-policy-revision path's required selection history, which as currently written they do not. Non-blocking note: the AC and Context also reference 'test/routing-ledger.test.js', which does not exist anywhere in this repo's git history (confirmed via `git log --follow`) — the ledger's tests actually live in routing-e2e.test.js/routing-overrides.test.js/routing-policy.test.js/routing-dashboard.test.js; this looks like a stale filename in the Task document itself rather than something the Attempt caused, but whoever addresses the blocking finding should not assume that file exists.
