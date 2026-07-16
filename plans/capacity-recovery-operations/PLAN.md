---
schema: aios.plan/v1
id: capacity-recovery-operations
project: aios-lab
profile: software-feature
profile_reason: Each of the three asks in the Brief is a new, additively-specified capability with its own contract, state, and operator surface (a widened worker capacity-corroboration boundary, a persisted cooldown schema plus a pure selection gate, and a ledger-recovery command) rather than a single defect with one root cause. The software-feature profile's separation of contracts, implementation, tests, and integration fits that shape far more precisely than bug-fix, whose reproduction/root-cause/correction/regression structure assumes one fault line, or generic-goal, which would not force the fail-closed and immutability contracts this work must preserve.
---

# Plan capacity-recovery-operations

## Brief

Make provider capacity outages and routing-policy changes operationally recoverable, addressing findings 2 through 5 of reports/dogfooding-whisky-frog-bundle1.md. First, a provider-reported usage-limit failure that the worker cannot corroborate through structured provider evidence (for example a plain 'You have hit your usage limit ... try again at <date>' error line) must surface as a structured capacity event carrying the provider-supplied reset time, not as a hard worker error that consumes the action's single fallback. Second, persist a per-candidate capacity cooldown (candidate id, retry_at, evidence) in machine-local runtime state so adaptive-routing selection skips cooled-down candidates until retry_at passes, records the skip as auditable gate evidence, expires cooldowns automatically, and gives the operator commands to list and clear them early when a quota resets ahead of schedule. Third, add an operator recovery command that resets the recorded routing decision rows for exactly one action key (task, role, attempt) whose steps are all non-terminal or failed, leaving the ledger schema-valid including its updated_at invariant and an auditable trace of the reset, so routing configuration edits between runs no longer strand actions on a policy-revision conflict with no remedy short of hand-editing runtime/routing-decisions.json. Preserve the fail-closed philosophy throughout: recorded decisions stay immutable, hard safety gates are never weakened, and every new state is validated on load. Verify with unit tests over fakes and fixture ledgers only; no provider calls and no live sessions.

## Profile Application

The `software-feature` profile shapes the work along four boundaries:

- **Contracts.** A widened, still fully-specified capacity-corroboration grammar
  at the Codex Worker boundary; a strict `aios.candidate-cooldowns/v1` state
  schema (candidate id, `retry_at`, bounded sanitized evidence) validated
  end-to-end on load exactly like `aios.routing-decisions/v1`; and a narrowly
  scoped ledger-reset contract that only ever appends a terminal status to
  existing rows and never rewrites recorded history. None of the three add a
  provider/model field to a Task or Plan document.
- **Implementation.** The Codex Worker adapter gains one additional,
  deterministic textual corroboration path that only engages when the existing
  structured app-server probe is unavailable or inconclusive. The pure
  `selectCandidate` engine gains one new hard-gate reason code driven entirely
  by validated function inputs, with no internal clock read or file I/O. Routed
  dispatch gains the write/prune side of the cooldown lifecycle, and the CLI
  gains three new operator commands (`aios route cooldowns`,
  `aios route clear-cooldown`, `aios route reset`).
- **Tests.** Every proposal is verified with unit tests over fakes and fixture
  ledgers/configuration only, matching the Brief's constraint: no real Codex or
  Claude process, no live app-server session, no network call, and no
  dependency on real elapsed wall-clock time for expiry behavior.
- **Integration.** The widened corroboration, the cooldown gate, and the reset
  command must each compose with the adaptive router's existing fail-closed
  invariants — fixed hard-gate ordering, non-overridable safety gates, atomic
  compare-and-swap ledger writes, and decision immutability — without relaxing
  any of them.

## Assumptions and Risks

- **Textual corroboration must stay narrow and fail closed.** The provider's
  own usage-limit message names a bare clock time or a bare month/day, not a
  full ISO timestamp, so resolving it to a concrete future `retry_at` requires
  anchoring to the session's own observation time and choosing the nearest
  future occurrence. Any message that does not match a small, fixed, documented
  grammar exactly (extra text, ambiguous or already-past resolution, more than
  one candidate date) must not be guessed into a capacity event; it keeps
  today's hard-failure behavior. This preserves the existing engine-level
  invariant, recorded in `plans/adaptive-model-routing/task-0038.md` and the
  project README, that recovery classification never relies on open-ended
  prose matching — the widened path is a second, equally strict evidence
  source feeding the same structured `capacity` contract, not a relaxation of
  it.
- **`selectCandidate` must stay pure.** `src/routing-policy.js` performs no
  file I/O, clock read, or random draw today; every input arrives pre-validated
  (`history`, `recovery`, `override`). The new cooldown gate must follow that
  exact shape — cooldown records and the "as of" observation time arrive as a
  validated function argument — so the module stays testable with fakes alone
  and the Brief's fixtures-only verification constraint is achievable.
- **The routing-decision ledger mirrors the policy's gate vocabulary and must
  be updated symmetrically.** `src/routing-ledger.js` imports
  `SELECTION_REASON_CODES` as its `GATE_CODES` and enforces a fixed gate
  ordering in `validateConsidered`. Adding a cooldown gate reason code without
  updating both files in the same change would reproduce the exact class of
  bug fixed in commit `11a84e0` (a considered-candidate reason code the ledger
  validator did not recognize). Both proposals touching gate reasons must land
  the policy and ledger sides together.
- **A route reset is a new terminal audit event, never a rewrite.** Recorded
  decisions are immutable by design, and finding 5 (an override cannot attach
  to an already-recorded action) is correct fail-closed behavior that this
  plan does not change. The remedy for a policy-revision conflict is to
  supersede the stranded action's existing rows with a new terminal status and
  let a fresh selection start clean under the current policy revision — never
  to mutate a recorded row's fields, attach an override after the fact, or
  delete history. Reset is scoped to exactly one action key and refuses when
  any of its steps already completed, so a finished action can never be
  silently redone.
- **New machine-local state follows the existing runtime-ledger discipline.**
  A persisted cooldown store lives under `.aios/runtime/` (already
  git-ignored), and is validated in full on every load, written with the same
  atomic-replace-plus-exclusive-lock compare-and-swap pattern as
  `routing-decisions.json`, and treated as empty when absent rather than
  silently repaired when malformed.
- **Verification is bounded to fakes and fixtures.** No proposal in this plan
  may add a test that spawns a real Codex/Claude CLI, opens a live app-server
  session, makes a network call, or depends on real elapsed wall-clock time to
  prove cooldown expiry; fixture clocks and fixture ledgers stand in for both.

## Decomposition Rationale

Four proposals keep each change independently reviewable and match the
Brief's three findings without conflating unrelated risk. The widened capacity
corroboration is first and stands entirely inside the Codex Worker adapter; it
changes what evidence can enter the existing `capacity` contract without
touching the routing engine, ledger, or CLI, so it can be reviewed and tested
in isolation from everything else in this plan.

The cooldown work splits in two because its risk has two different shapes.
The first half defines the persisted state schema and extends the pure
selection engine with the new gate, together with the matching ledger
validation update — a small, fully deterministic change verifiable entirely
with fixtures and fakes, free of any file I/O or CLI concern. The second half
wires that contract into real dispatch (creating cooldowns from corroborated
capacity evidence, pruning expired ones, and reading them at selection time)
and adds the operator-facing list/clear commands; this half depends on
persistence, timing, and CLI parsing concerns that would otherwise dilute the
first half's purity guarantees if merged together.

The route-reset command is last and is independent of the cooldown work: it
only touches the existing decision-ledger's terminal-state and
policy-revision machinery. It is ordered last because it is the plan's only
Task the operator invokes by hand between loop runs rather than something the
engine exercises automatically, and reviewing it after the rest of this plan's
ledger-adjacent changes land keeps its narrow, safety-critical diff free of
unrelated churn. Relationships live only in this Execution Order; every
proposal body stands alone and contains no dependency fields or cross-proposal
references.

## Execution Order

1. task-0036 widens Codex Worker capacity corroboration so a provider-reported
   usage-limit failure the structured app-server probe cannot corroborate
   still surfaces as a structured capacity event when its own reported text
   unambiguously matches a fixed reset-time grammar, and otherwise fails
   closed exactly as today.
2. task-0037 defines the validated per-candidate cooldown state contract and adds a
   new, non-overridable hard gate to the pure adaptive-routing selection
   engine and its matching ledger validation, entirely through validated
   function inputs.
3. task-0038 persists candidate cooldowns from corroborated capacity evidence,
   reads and prunes them at every routed selection, and adds
   `aios route cooldowns` and `aios route clear-cooldown` for the operator.
4. task-0039 adds `aios route reset` so an operator can supersede the recorded rows
   for one stranded, non-terminal-or-failed action key and unblock a fresh
   selection under the current routing-policy revision without hand-editing
   the decision ledger.
