---
schema: aios.plan/v1
id: adaptive-model-routing
project: aios-lab
profile: software-feature
profile_reason: Adaptive model routing is new engine-adjacent product behavior whose main risks are configuration and decision contracts, deterministic policy evaluation, bounded failure recovery, compatibility with the existing Role loop, and end-to-end verification. The software-feature profile's contracts, implementation, tests, and integration emphasis fits those risks more narrowly than generic-goal.
---

# Plan adaptive model routing across Claude and Codex

## Brief

Turn today's Role-only command assignment into an auditable Task-and-Role-aware
routing policy. The router chooses from an explicit operator-configured Claude
and Codex candidate catalog using the work's profile, complexity, risk, context
size, tool needs, verification burden, latency/cost budget, and prior outcomes.
Planning always requires a high-capability candidate. A lower tier is eligible
only for a bounded, low-risk downstream Role after the work has been decomposed
well enough to verify independently. Reviewer capability is never below the
Implementer's tier and different-provider review is preferred when eligible.

Fitness is the first filter. Only materially equivalent candidates participate
in configurable provider distribution, and a persisted decision key prevents
the choice from drifting when the same Task/Role action is resumed. Capacity,
timeout, provider failure, test failure, rejected review, repeated evidence,
and repeated context failure have explicit bounded fallback or escalation
paths. Every choice, alternative, rationale, override, and distribution effect
is recorded without putting provider choices into Task documents. Existing
`aios.assignments/v1`, single-Task execution, sequential plan progression,
approval gates, and the session ledger remain compatible. Concurrency and a
daemon remain out of scope.

## Profile Application

The `software-feature` profile shapes the work along six boundaries:

- **Contracts and workload evidence.** A versioned routing configuration owns
  the candidate inventory, capability tiers, budgets, provider targets, and
  provider-neutral Task hints. Runtime context also includes the active Role,
  parent plan profile when discoverable, Task structure, approval/retry state,
  and prior Review/session evidence. Unknown or ambiguous evidence fails
  conservatively toward a stronger tier; it never makes a lower tier eligible.
  Task and Review document schemas do not gain provider/model fields.
- **Deterministic selection and audit.** A pure policy layer filters candidates
  by hard capability gates, ranks fitness, applies distribution only within the
  best materially-equivalent set, and persists a decision before dispatch.
  Re-resolving the same decision key returns the recorded candidate unless a
  recorded failure advances that exact decision through its bounded route.
- **Engine integration and recovery.** `LoopEngine` supplies Task, Role,
  attempt, Review, and run-option context to a compatible resolver. A routed
  Worker handles only dispatch choice and bounded recovery; validation, Task
  transitions, retry limits, capacity continuation, Review projection, and
  approval remain engine responsibilities.
- **Operator control.** `run` and `progress` accept an explicit validated
  routing override without changing Task documents. Invalid or unavailable
  overrides fail closed before dispatch, and valid overrides are audited.
- **Operational visibility.** The existing offline dashboard reads the new
  routing ledger alongside the session ledger, showing why a model was chosen
  and whether a fallback, escalation, override, or distribution correction
  affected it. It remains read-only.
- **Verification.** Pure policy fixtures prove stable decisions and safety
  invariants; engine tests prove bounded fallback and unchanged gates; a
  disposable mixed-provider simulation proves selection, review separation,
  fallback, escalation, audit, CLI, progression, and dashboard behavior without
  paid sessions.

`generic-goal` was considered and rejected because the brief is not an
open-ended outcome: it is a concrete execution-policy feature with contract,
compatibility, failure-semantics, and integration risks.

## Assumptions and Risks

- Planner is an upstream convention implemented by an ordinary planning Task,
  not a fourth engine Role. Therefore the high-tier invariant cannot rely only
  on `AIOS_ROLE`. Routing configuration may supply provider-neutral workload
  hints keyed by Task or plan, while deterministic document evidence can mark
  a plan-only Task. If planning cannot be established safely, an unknown or
  approval-required workload stays high tier; no title-only guess may unlock a
  lower tier.
- Provider and model availability changes independently of repository code.
  Source code must not contain a supposedly current model list. The operator
  catalog declares stable candidate ids, exact provider/model identifiers,
  command argv, tier, supported Roles, context/tool capabilities, cost/latency
  class, and enabled state. Unknown ids, tiers, capabilities, or duplicate
  candidates are configuration errors, not best-effort guesses.
- Complexity, risk, tool need, and verification burden are partly semantic.
  The first version uses inspectable inputs: plan profile, explicit
  provider-neutral hints, Task size and acceptance/constraint structure,
  approval requirement, retry count, Review history, and declared required
  capabilities. Missing hints make the assessment more conservative. An opaque
  model-scored router is out of scope.
- Distribution must never override fitness. Provider weights apply only after
  hard gates and best-fitness grouping. The policy records the counters/window
  it observed and the before/after deficit for each equivalent provider. A
  deterministic candidate-id tie break handles equal deficits.
- A decision must be idempotent even while the distribution ledger grows. Its
  key includes Task id, Role, engine attempt/review generation, and routing
  policy revision. The first choice is persisted atomically before Worker
  launch; repeated resolution returns it. A fallback is a child step of that
  same decision, never a fresh distribution draw.
- Provider continuations are not portable. Capacity continuation may resume
  only the same candidate. A cross-provider fallback starts a new session with
  the full Task document and recorded prior failure context, and never passes a
  foreign continuation token. The operator's existing capacity-wait settings
  remain meaningful when no eligible fallback remains or policy explicitly
  chooses same-provider continuation.
- A Review rejection already consumes the Task's existing retry budget. The
  next Implementer resolution observes that history and may promote tier, but
  routing never resets or extends `retry.limit`. A test-failure Result,
  duplicate Attempt evidence, timeout, or context failure may try a stronger
  candidate inside one Role action only up to configured per-action and
  per-Task bounds. Once exhausted, the existing halt/block behavior wins.
- The session ledger describes actual Worker sessions but cannot explain
  alternatives considered before launch. Extending it would make one schema
  carry two different lifecycles and would miss pre-dispatch failures, so a
  separate atomic `.aios/runtime/routing-decisions.json` ledger is justified.
  It stores candidate/provider/model identifiers and reason codes but never
  command argv, credentials, prompt bodies, or continuation tokens.
- Existing `aios.assignments/v1` remains the compatibility mode. It produces
  the same Worker and behavior as today and does not fabricate routing audit
  claims. Routing is enabled only by an explicit versioned routing config.
- This work assumes the existing single foreground engine and sequential
  `progress` command. It does not solve simultaneous operators, concurrent
  Task dispatch, global provider reservation, or live remote capacity polling.

## Decomposition Rationale

Six proposals keep each change independently reviewable. Candidate/config
validation and provider-neutral workload assessment come first because policy
cannot be tested honestly against invented inventory or hidden inputs. The
pure selection engine and atomic decision ledger come second; keeping them
free of Worker launch and CLI concerns makes fitness, distribution, and
idempotency testable with deterministic fixtures.

Engine integration is third and owns all fallback/escalation semantics because
those behaviors must be reviewed together with the existing Role loop and
retry/capacity gates they affect. CLI overrides are separate so operator
control can be tested without mixing argument parsing into policy code. The
dashboard is another independent, read-only ledger consumer. The last proposal
assembles the feature in a disposable mixed-provider demonstration and updates
documentation after all contracts are stable. Relationships live only in this
execution order; proposal bodies remain standalone and contain no dependency
fields or cross-proposal references.

## Execution Order

1. task-0024 defines and validates the candidate catalog and derives conservative,
   provider-neutral workload context while preserving legacy Assignment mode.
2. task-0025 implements deterministic fitness/distribution selection and the atomic,
   idempotent routing-decision ledger.
3. task-0026 integrates routed dispatch with the Loop Engine and implements bounded,
   loop-safe fallback and escalation without weakening retry or approval gates.
4. task-0027 adds validated per-run routing overrides to `aios run` and
   `aios progress` and reports the active decision in command output.
5. task-0028 shows routing choices, alternatives, overrides, fallback/escalation,
   and distribution effects in the existing read-only dashboard.
6. task-0029 proves the assembled feature with a disposable mixed-provider
   end-to-end simulation, full regression coverage, and operator documentation.
