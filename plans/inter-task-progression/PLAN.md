---
schema: aios.plan/v1
id: inter-task-progression
project: aios-lab
profile: software-feature
profile_reason: The goal is new engine-adjacent product behavior — an
  operator-invoked command that advances an adopted plan's already-ordered
  real Tasks by repeatedly invoking the existing single-Task Loop Engine — so
  the interesting risk is a stable execution contract, deterministic
  execution-state derivation, recovery/stop correctness, and integration with
  the existing CLI and dashboard, not information architecture or a data
  migration. software-feature's contracts/implementation/tests/integration
  emphasis maps directly onto that risk.
---

# Plan automatic progression across adopted Tasks

## Brief

Turn "let an operator start or resume an adopted plan and have AIOS advance
through its ordered Tasks without manually invoking each Task" into a
reviewed set of focused Task proposals. The result must read the real Task
order already written into an adopted `PLAN.md`, invoke the existing
single-Task Loop Engine per Task instead of duplicating any of its
responsibilities, remain deterministic and resumable from repository state
alone, stop safely at every required human/Worker/system boundary, keep
human control visible (current plan, current Task, completed count, stop
reason, exact operator action), extend the dashboard's read-only visibility
without turning it into a mutating control surface, and prove itself with
both unit coverage and a disposable end-to-end demonstration. No Task
dependency fields, no daemon, no adaptive model routing.

## Profile Application

`software-feature`'s decomposition emphasis — contracts, implementation,
tests, integration — maps onto this brief as follows:

- **Contracts.** The Loop Engine's `run(taskId, options) -> outcome` contract
  (`src/engine.js`) is the one thing every proposal below must reuse, not
  reimplement: Role dispatch, Review projection, Approval handling, capacity
  continuation, retry limits, and session recording all stay inside
  `LoopEngine`. The only contract change this plan allows is a small,
  additive, backward-compatible extension to the engine's outcome shape (a
  stable machine-readable stop category alongside the existing human-readable
  `reason`), because today's `reason` strings vary by internal code path and
  are not a safe classification surface for a caller. Task documents,
  `aios.task/v1`, and `aios.plan/v1` gain no new fields. Because this
  outcome-shape change extends the engine surface, the proposal that makes
  it carries `approval: required` itself, under the same operator policy
  (from the task-0008 retrospective, already applied to task-0012 and
  task-0017) that requires a human gate after review for engine-surface
  changes — not only the later CLI proposal that consumes the extended
  contract.
- **Execution state.** Progress is derived, not stored: the ordered real Task
  ids already written into an adopted `PLAN.md`'s Execution Order section,
  plus each named Task's current `state`/`retry`/`approval` (read the same
  way the engine and dashboard already read Tasks), are sufficient to compute
  "what is done, what is next, why did the last run stop." No new persisted
  execution-run document is introduced.
- **Implementation.** One narrow, operator-invoked command loops "read plan
  order, skip done Tasks, run the engine once on the next unfinished Task,
  stop on any non-`done` outcome" — the smallest surface that satisfies the
  brief.
- **CLI integration.** The command joins the existing `run` / `dashboard` /
  `adopt` subcommands in `src/cli.js` with the same argument, exit-code, and
  JSON-report conventions, and must not change those existing subcommands'
  behavior.
- **Tests / verification.** Unit coverage is required for ordering, resume,
  every stop condition, and idempotent re-invocation; a disposable end-to-end
  demonstration is required to prove two adopted Tasks complete in order from
  one operator command; existing `aios run` behavior must be shown unchanged.

`generic-goal` was considered and rejected as strictly weaker guidance for a
brief that is entirely about a new execution contract and its integration
surface, not an ambiguous goal.

## Assumptions and Risks

- After `adopt`, `PLAN.md`'s Execution Order section contains each real Task
  id exactly once in intended sequence (this is already enforced by
  `src/plans.js` validation at adoption time for the placeholder form, and
  `adopt` rewrites placeholders to real ids with the same text positions).
  Progression can treat that section as its sole ordering source without any
  new dependency field. Risk: a hand-edited `PLAN.md` after adoption could
  desynchronize order from intent; progression must fail closed (stop with an
  invalid-document reason) rather than guess, and must not rewrite `PLAN.md`
  itself.
- "Completed" is exactly `state: done`; a Task already `done` when
  progression starts is skipped, never rerun. Risk: an id collision across
  projects — mitigated by requiring every Task named in the plan's Execution
  Order to have `project` equal to the plan's `project`, the same check
  `adopt` already applies to proposals before they become Tasks.
- No new persisted execution-run record means two operators invoking
  progression on the same plan concurrently could race on the same Task the
  same way two concurrent `aios run` invocations already could. Sprint 0
  (README "Limits") already assumes one foreground Loop Engine; this plan
  inherits that assumption rather than solving concurrent scheduling, and
  relies on the engine's existing conflict detection to halt safely rather
  than corrupt a Task.
- Classifying *why* a run stopped needs to be robust across Worker failure,
  invalid document, exhausted retry, capacity wait, cancellation, and
  conflict. Pattern-matching the engine's free-text `reason` would be
  brittle and would silently drift as Worker error strings change. The
  concrete risk this plan flags is scope creep in the opposite direction —
  reinventing failure detection instead of the minimal, additive engine
  outcome extension described above.
- Cancellation during an active Worker execution (not just a capacity-wait
  sleep) needs the same `AbortSignal` wiring `aios run --wait-for-capacity`
  already establishes for SIGINT/SIGTERM, extended to cover the whole
  multi-Task loop, not just one Task.
- Dashboard visibility must stay read-only, and it must stay honest about
  what it can and cannot see now that this plan deliberately adds no
  persisted execution-run record. Two distinct risks: scope creep toward a
  "start/stop" button — out of scope per task-0017's constraints (no daemon,
  no implicit auto-start, no mutating control surface) — and, separately,
  scope creep toward implying the dashboard can reconstruct a transient
  run-time event it never persisted anywhere. A Task's current
  `state`/`approval`/`retry` fields make the approval-gate, blocked, and
  invalid-document stop conditions genuinely re-derivable at any later time,
  so the dashboard may report those as current state, reusing the same
  derivation the CLI command uses. Worker failure and capacity wait leave no
  distinguishing mark on a Task's current state, but the existing session
  ledger (`src/sessions.js`) does record a `failed` or `capacity_deferred`
  outcome per Task/Role with a timestamp, so the dashboard may surface that
  as clearly labelled last-observed evidence, distinct from current state
  and never presented as a live status. Cancellation and repository-mutation
  conflict are recorded nowhere at all — the session ledger's outcome
  vocabulary is only `completed`/`failed`/`capacity_deferred`, and the
  `approver` Role's own Worker executions are never written to the ledger —
  so the dashboard must not claim either is observable, live or historical;
  both stay CLI-only, visible only in the moment `aios progress` reports
  them.

## Decomposition Rationale

The work splits into four proposals along the profile's contracts →
implementation → integration → verification axis, with recovery/stop
semantics folded into the first proposal rather than split out on its own:
the stop policy is not a separable add-on, it is the core correctness
property of the loop itself, and it cannot be meaningfully implemented or
reviewed apart from the loop it governs. Splitting it out would produce two
proposals that could not be independently verified.

Putting the core progression library first lets its Worker session finish
and be independently verified — through automated tests against a pure
function/class with no CLI or HTML concerns — before anything consumes it.
CLI integration is next and stays a thin, operator-facing layer over that
already-tested core, mirroring how `src/cli.js` already stays thin over
`src/engine.js`, `src/plans.js`, and `src/dashboard.js`; its own focused
concern is argument parsing, operator-facing reporting, exit codes, and
proving existing commands are unchanged. Dashboard visibility is a third,
independent read-only consumer of the same core output and does not depend
on the CLI proposal, but is sequenced after it so the dashboard proposal can
describe the same operator actions the CLI already reports, keeping the two
surfaces consistent. The end-to-end demonstration and cross-command
regression proof come last because they exercise all three prior proposals
assembled together, which is a distinct verification activity from the
durable unit tests each earlier proposal already carries — none of the
proposals below needs a dependency field; their relationship is expressed
only by this order.

## Execution Order

1. task-0019 delivers the core progression library: ordered-Task derivation from
   an adopted plan, deterministic next-Task selection, a minimal additive
   Loop Engine outcome extension for stable stop-reason classification, and
   the full stop policy, with unit coverage for ordering, resume, every stop
   condition, and idempotent re-invocation.
2. task-0020 wires that library into a new `aios progress` subcommand in
   `src/cli.js`, with operator-facing reporting, exit codes, cancellation,
   and capacity-flag passthrough, and proves the existing `run`, `dashboard`,
   and `adopt` subcommands are unchanged.
3. task-0021 extends the existing offline dashboard with a read-only "Plan
   Progress" section reusing the same core derivation, without adding any
   mutating control.
4. task-0022 proves the assembled system with a disposable demonstration in which
   two adopted Tasks complete in order from one operator command, plus
   documentation of the new command consistent with the existing README.
