---
schema: aios.review/v1
id: review-0038
project: aios-lab
task: task-0025
attempt: 1
verdict: changes_requested
---

# Review of task-0025, Attempt 1

## Findings

Blocking defects:
1. `RoutingDecisionLedger.#commit` is not compare-and-swap safe: it reads and compares the file, then performs a separate `atomicReplace`. Two overlapping writers can both pass the comparison and the later rename silently loses the earlier decision. The supplied test checks only a sequential stale snapshot. Implement a genuinely conflict-safe repository-local conditional-write pattern and test overlapping writes. Also validate that the supplied snapshot fields actually correspond to `snapshot.raw`; a fabricated/cloned snapshot with the current raw can currently rewrite history.
2. The selector does not strictly validate normalized workload invariants. An implementation context with `lower_tier.eligible: true` and no rejection reasons is routed to a lower tier even when risk is high, approval is required, verification is unknown, retries exist, or other conservative evidence contradicts eligibility. Enforce consistency with every normalized lower-tier gate (and reject unknown/extra malformed fields) so conservative defaults cannot be bypassed; add contradiction tests.
3. The strict ledger can store prohibited content through arbitrary `workload.sources` keys and values. `validateWorkloadSummary` accepts any bounded source string, including credentials, command argv, prompt fragments, or a `prompt`/`environment` field, without sanitization or a closed evidence-source contract. Restrict this to the normalized source schema/vocabulary or otherwise reject/sanitize prohibited content, and add storage tests for these bypasses.
4. Pre-dispatch persistence is not enforced. `decisionRecordFromSelection` and `record` accept `dispatched`, `completed`, or `failed` as the initial persisted status, and outcome updates may skip directly from `selected` to a terminal state. Require initial records to be `selected` and enforce the intended dispatch/outcome transition sequence, with tests.
