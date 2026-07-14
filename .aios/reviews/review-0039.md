---
schema: aios.review/v1
id: review-0039
project: aios-lab
task: task-0025
attempt: 2
verdict: changes_requested
---

# Review of task-0025, Attempt 2

## Findings

Blocking defects:
1. Reviewer safety can be bypassed because validateImplementerDecision does not bind candidate/provider/tier to the validated catalog. A caller can provide an existing candidate with a fabricated lower tier or different provider, causing selection below the actual Implementer tier or defeating cross-provider preference. Require an exact decision shape and verify the candidate exists and its provider/tier match the catalog.
2. Workload provenance is not actually validated against the key or configuration. For example, task-9001 can claim routing.hints.task:task-9999—or a hint absent from config—and still qualify for lower tier. The current lower-tier test fixture does exactly this with an empty hints catalog. Verify hint sources identify the current Task or discovered parent plan, exist in config, and agree with the normalized values; also require rejection_reasons to match the failed gates.
3. The supposedly strict ledger accepts malformed or prohibited records. validateWorkloadSummary accepts invalid normalized enums such as risk="banana"; validateDistribution accepts negative targets, counts that do not sum to observed, duplicate/inconsistent providers, and changed_winner=true when distribution was not applied. Candidate model strings are unbounded arbitrary text, so a validated catalog can place command argv, prompt text, or credentials in considered/chosen.model and the ledger stores it verbatim. Close these schemas and enforce their mechanically checkable cross-field invariants so malformed content fails load rather than becoming audit history.
4. Required unit coverage remains incomplete: there are no explicit assertions for every lower-tier rejection code (notably work_not_bounded_implementation, capabilities_not_explicit, and safety_evidence_uncertain), nor a candidate-id tie case within the selected provider. Add those tests along with regression tests for the defects above.
