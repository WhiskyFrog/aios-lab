---
schema: aios.plan/v1
id: route-reset-distribution-recovery
project: aios-lab
profile: bug-fix
profile_reason: "The Brief names one concrete, reproducible failure string ('distribution.observed must equal the actual preceding ledger window'), a specific fixture shape that reproduces it (ordinary preceding decisions plus a genuine resetAction-produced superseded generation), and asks for a single consistent, documented counting rule plus regression coverage of the real routed dispatch/record path — the exact reproduction/root-cause/correction/regression-coverage shape the bug-fix profile names, not an additive capability (software-feature) or an unscoped exploratory goal (generic-goal)."
---

# Plan route-reset-distribution-recovery

## Brief

Fix the reviewed route-reset workflow so a real aios run/progress can record a fresh step-0 decision after the prior action generation is superseded and the routing policy revision changes. Reproduce the observed failure 'distribution.observed: must equal the actual preceding ledger window' with a fixture containing ordinary preceding decisions plus a genuine resetAction-produced superseded generation, make selection history projection and routing-ledger distribution-window replay use one consistent documented generation/counting rule without deleting or rewriting history, preserve immutable audit rows and fail-closed validation, and add regression coverage that exercises the real routed dispatch/record path after reset. Also cover or explicitly prevent same-policy exact-key collisions so the CLI contract cannot claim a fresh sequence that record rejects. Use fixture tests only; no provider calls or live sessions.

## Profile Application

The `bug-fix` profile shapes the work along its four named boundaries:

- **Reproduction.** Both proposals start from a fixture ledger built with real,
  in-order preceding decisions plus a real `resetAction()`-produced superseded
  generation — never a decoy row standing in for the case that actually
  triggers the fault, which is exactly what `review-0055` flagged as missing
  coverage in the prior attempt at this workflow. Each proposal's tests must
  fail against today's code before its correction lands and pass after.
- **Root cause.** Both failures trace to the same architectural gap: some
  functions that scan `RoutingDecisionLedger`'s `decisions` array already
  respect the generation boundary a route reset creates (`resolveKey`,
  `record`'s open-sequence check, and — since task-0039 attempt 2 —
  `historyProjection` via `currentGenerationDecisions`), while two others do
  not. `validateLedger`'s per-record distribution-window replay
  (`src/routing-ledger.js` ~line 1140) re-derives its window with a raw
  positional slice of the full, unfiltered `decisions` array, independently of
  `currentGenerationDecisions`. `findRecordIndex` (~line 1278), which
  `record()` uses to decide whether a candidate row already exists at a given
  key/step, matches on `(task, role, attempt, policy_revision, step)` alone
  with no notion of generation or status at all. Root-causing each proposal
  means naming exactly which generation-unaware lookup is inconsistent with
  the generation-aware ones, not just patching the symptom.
- **Correction.** Each correction is expressed as: pick one documented
  generation-counting/keying rule and make every site that needs it — the
  selection-time projection and the ledger's own validation replay for
  distribution; the exact-match lookup `record()` relies on for
  same-policy resets — use that one rule, instead of each site re-deriving its
  own. No correction may delete, reorder, or rewrite any already-recorded
  decision row or event; a reset row keeps superseded status, its own events,
  and its own recorded fields exactly as `resetAction` left them.
- **Regression coverage.** Every proposal's regression test drives the real,
  exported path an operator's `aios run`/`aios progress` actually calls after
  `aios route reset` — `historyProjection`, `selectCandidate`, and
  `RoutingDecisionLedger.record` wired together as `routing-dispatch.js` wires
  them — not an isolated call to a single internal function standing in for
  that path.

## Assumptions and Risks

- **The two failures share a cause but are independently fixable and
  independently observable.** The distribution-window mismatch is detected by
  `validateLedger` and raises a validation error on load/commit; the
  same-policy exact-key collision is detected by `record()`'s exact-match
  check and raises a "Refusing to rewrite recorded decision" error before
  validation is ever reached. Confirmed by direct code reading
  (`src/routing-ledger.js` lines ~1130-1160 and ~1278-1425): a fresh step-0
  record cannot even reach the distribution-window replay in the same-policy
  case, because `record()` rejects it first. This plan treats them as two
  proposals so each stays reviewable against its own fixture and its own
  narrow correction, while both proposals document and converge on the same
  underlying generation rule so a third inconsistent site is not created.
- **The distribution window is global, not per-key.** `distribution.window`/
  `observed`/`counts` are computed over the whole ledger's recent decisions
  across every task/role/attempt (load-balancing evidence), not scoped to one
  partial key. A generation-aware fix must therefore filter out only the rows
  belonging to a *closed* generation (fully superseded, per
  `currentGenerationRows`) at each point in append order, not filter by
  partial key wholesale — a naive per-key exclusion would silently change the
  window arithmetic for ledgers that have never seen a route reset, which
  Constraints and README both forbid.
- **Existing, no-reset ledgers must replay identically.** Neither correction
  may change `distribution.observed`/`counts` validation, `record()`
  acceptance, or any recorded field for a ledger that has never had a route
  reset. Both proposals' acceptance criteria require the full existing
  `test/routing-ledger.test.js`, `test/routing-policy.test.js`, and
  `test/routing-dispatch.test.js` suites to keep passing unmodified, which is
  the fixture-only proof that the fix is additive to the generation case and
  not a behavior change to the ordinary case.
- **Immutability and fail-closed validation are non-negotiable.** Recorded
  decision rows and their events are append-only; `resetAction` already only
  ever appends a `reset` event and flips `status` to `superseded`
  (`src/routing-ledger.js` ~line 1637). Neither proposal may make
  `validateLedger`, `record()`, or `resetAction` more permissive than
  necessary to admit the one legitimate case each targets — a validation
  bypass that happens to make the reported error disappear (for example,
  dropping the distribution check instead of correcting its counting rule) is
  the failure mode Constraints exist to prevent.
- **Same-policy resets are a real, currently uncovered case.** `resetAction`
  never inspects or requires a policy-revision change
  (`src/routing-ledger.js` ~line 1637-1700); an operator may run
  `aios route reset` purely to clear a stuck/failed action while the routing
  policy is unchanged. `test/routing-reset.test.js` today only exercises a
  changed policy revision (`policy-v2`) after reset, so the same-policy path
  through `record()`'s exact-match lookup is unexercised — this is the gap
  the Brief's "also cover or explicitly prevent" clause names.
- **Verification is bounded to fixtures.** Neither proposal may add a test
  that spawns a real Codex/Claude process, opens a live app-server session,
  or makes a network call; fixture ledgers, a fixture routing config, and the
  existing `execFile`-driven CLI subprocess pattern already used in
  `test/routing-reset.test.js` are sufficient to reach the real dispatch/CLI
  surface.

## Decomposition Rationale

Two proposals, ordered to match the Brief's own ordering of its primary
reported failure and its secondary "also cover or explicitly prevent" clause.

task-0041 corrects the literal reported failure: the distribution-window
generation-counting mismatch between selection-time history projection
(`historyProjection`, generation-aware since task-0039 attempt 2) and the
ledger's own per-record validation replay (`validateLedger`, still
generation-unaware). This is a self-contained change inside
`src/routing-ledger.js`'s window-replay logic (and, if the chosen rule
requires it, `src/routing-dispatch.js`'s projection), verifiable entirely
against fixture ledgers, and matches exactly the failure string and fixture
shape the Brief specifies. It is ordered first because it is the Brief's
headline reproduction target and because its correction establishes the one
documented generation-counting rule that task-0041's own tests, and any future
window-touching code, can point to.

task-0042 addresses the Brief's second, related but distinct concern:
`record()`'s exact-match key lookup (`findRecordIndex`) has no notion of
generation or status, so a fresh step-0 selection recorded after a reset
that left the policy revision unchanged collides with the superseded row at
the identical `(task, role, attempt, policy_revision, step)` key and is
rejected as an attempted rewrite — even though the CLI/dispatch contract
established by task-0039 promises a fresh sequence "exactly as if the action
had never run before." This is ordered second because it is a narrower,
independently testable change confined to `record()`'s lookup (and, if
needed, the CLI's reset-success messaging/README), and because reviewing it
after task-0041 lands keeps its diff free of the unrelated distribution-window
correction. Relationships between the two live only in this Execution
Order; neither proposal body names or depends on the other.

## Execution Order

1. task-0041 reproduces 'distribution.observed: must equal the actual preceding
   ledger window' with a fixture combining ordinary preceding decisions and a
   genuine `resetAction()`-produced superseded generation, then makes
   selection history projection and the ledger's distribution-window replay
   share one documented generation-counting rule, verified through the real
   routed dispatch/record path.
2. task-0042 reproduces `record()` rejecting a legitimate fresh step-0 selection
   recorded after a real reset when the policy revision is unchanged across
   the reset, then makes `record()`'s exact-key lookup generation-aware (or
   explicitly documents and fail-closes the unsupported case) so the CLI
   contract never claims a fresh sequence that `record()` would reject.
