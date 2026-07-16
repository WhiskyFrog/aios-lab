---
schema: aios.review/v1
id: review-0053
project: aios-lab
task: task-0037
attempt: 1
verdict: pass
---

# Review of task-0037, Attempt 1

## Findings

All acceptance criteria verified against the actual working-tree code, not just the Attempt's claims. src/routing-cooldowns.js defines aios.candidate-cooldowns/v1 with exact-keyed record/document validation, a candidate id matching the existing catalog IDENTIFIER shape, ISO retry_at, and evidence sanitized with the same secret/path redaction rules as routing-ledger.js's normalizeFailureReason, tied to a failure-reason-code vocabulary. src/routing-policy.js:101-102 inserts candidate_cooldown_active into SELECTION_REASON_CODES immediately after candidate_disabled without reordering any other entry, and it is absent from OVERRIDE_DISPLACEABLE_REASON_CODES (confirmed by test + override throwing 'violates hard safety gates: candidate_cooldown_active'). selectCandidate gains validated cooldowns/asOf inputs (validateCooldowns, lines ~626-652) with no file I/O, clock read, or env access; the gate at line ~1036 applies candidate_cooldown_active only when cooldown.retry_at is strictly after asOf, both normalized to comparable ISO strings, and it runs before role/capability/cost/tier gates exactly like candidate_disabled. The considered row shape (candidate/provider/model/tier/eligible/reasons) is unchanged. src/routing-ledger.js needed no edit because GATE_CODES = new Set(SELECTION_REASON_CODES) (line 74) and the fixed-order check in validateConsidered uses SELECTION_REASON_CODES.indexOf (line 513), so both derive dynamically and already cover the new code/position symmetrically. src/routing.js (the aios.routing/v1 catalog schema) is untouched. Tests in test/routing-cooldowns.test.js and test/routing-policy.test.js cover all four required scenarios (future retry_at -> ineligible with exactly the new reason; past/equal retry_at -> fully eligible; cooldown reroutes selection to next-best candidate; considered row with the new reason passes validateDecisionRecord) plus the override-cannot-restore case. Ran `npm test`: 366/366 pass, 0 fail.
