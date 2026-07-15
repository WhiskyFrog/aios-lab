# AIOS Loop Engine

AIOS treats Task documents as the durable worklist. One foreground command
reads a Task's state, resolves the next Role through the current Assignment,
invokes its Worker, validates the Result, and continues until the Task is
`done`, `blocked`, or halted.

Sprint 0 deliberately has no daemon, watcher, Redis, message queue, event bus,
or multi-process scheduler.

## Run

Install the single YAML 1.2 parser dependency:

```console
npm install
```

Create an Assignment file outside the Task documents:

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "implementer": ["node", "workers/implementer.mjs"],
    "reviewer": ["node", "workers/reviewer.mjs"],
    "approver": ["node", "workers/approver.mjs"]
  }
}
```

Then start one Task once:

```console
npm run aios -- run task-0003 --assignments .aios/assignments.json
```

The Assignment file is re-read before every Role action. Replacing a command
changes the Worker without changing the Task or Loop Engine.

When a Review requests changes, the loop may invoke the Implementer again in
the same foreground run. A replacement Attempt must provide new summary or
verification evidence. If both fields exactly repeat the preceding framed
Attempt, the run halts for operator recovery before appending another Attempt,
creating another Review, or consuming another retry. Replace or correct the
Worker and rerun; the Task remains resumable in `implement`.

`aios run` exits with 0 when the Task reaches `done`, 2 when it reaches
`blocked`, 1 when the run halts for operator recovery, and 64 for a usage
error. A structured capacity deferral exits with 75 and reports `retry_at`
unless capacity waiting is enabled.

Assignment commands are trusted local configuration and run with the current
user's permissions. Do not execute an Assignment file from an untrusted
repository.

## Capacity Wait and Session Usage

Capacity waiting is explicit. Keep one foreground Task run alive across a
provider-reported refill window with:

```console
npm run aios -- run task-0009 --wait-for-capacity
```

`--max-capacity-wait-ms` bounds the cumulative requested wait (default
`604800000`, seven days), and `--max-capacity-pauses` bounds deferrals across
the whole foreground run (default `8`). The child Worker timeout still applies
to each active invocation; refill sleep happens after the child exits. Ctrl+C
or SIGTERM cancels the sleep.

The engine waits only for the command transport's structured capacity signal
with a future `retry_at` and opaque continuation. It checks the Task bytes
before sleeping and again before resuming the same resolved Worker. A capacity
pause does not change Task state, consume Task retries, append an Attempt, or
create a Review. Authentication, billing, permission, network, timeout,
malformed output, and ordinary Result failures still halt for operator
inspection. Token counts are telemetry only and are never used to guess a
refill time.

Structured Claude and Codex runs are recorded in the git-ignored
`.aios/runtime/sessions.json`. This atomic operational ledger keeps one row per
provider session with Task, Role, model, invocation count, token usage, cost,
latest capacity utilization, and reset time when a provider supplies them.
Usage and cost are accumulated across resumed invocations of the same session.
The ledger is not Task lifecycle truth and can be deleted without changing any
Task.

## Progress an Adopted Plan

Run the ordered real Tasks in one already-adopted plan from a single foreground
operator command:

```console
npm run aios -- progress plans/public-site --root . --assignments .aios/assignments.json
```

The plan path follows `adopt` resolution: an absolute path is used as-is and a
relative path is resolved under `--root` (default: the current directory).
`--assignments` defaults to `<root>/.aios/assignments.json`, and
`--timeout-ms` defaults to `300000` for each Worker invocation. Capacity
options have the same semantics and defaults as `run`: waiting is off unless
`--wait-for-capacity` is supplied, `--max-capacity-wait-ms` defaults to
`604800000`, and `--max-capacity-pauses` defaults to `8`.

The command skips every Task already in `done`, runs the first unfinished Task
through the existing Role loop, and continues in plan order until all Tasks are
done or one reaches a stop condition. Its JSON report includes the plan id,
completed Task ids, current Task, stop reason, and exact operator action.
Re-running the same command is idempotent with respect to repository state:
completed Tasks are not invoked again, so an operator can perform the reported
action and resume without reconstructing an in-memory scheduler.

SIGINT or SIGTERM covers the whole multi-Task command. Cancellation stops the
active Worker or a capacity sleep and is also checked before dispatching the
next Task, so no new Worker starts after cancellation. The completed-so-far
list remains in the report. Exit codes are:

- `0`: every Task in the plan is complete.
- `3`: awaiting human approval.
- `4`: blocked by rejection or retry exhaustion.
- `5`: waiting for Worker capacity.
- `6`: cancelled.
- `7`: another halt, including Worker, document, or repository-conflict errors.
- `64`: command usage error.

## Dashboard

`aios dashboard` generates one self-contained, offline HTML file summarizing
every Task's lifecycle position and evidence, so an operator can see what
the loop is doing and what needs a human without reconstructing state from
raw `.aios/` files:

```console
npm run aios -- dashboard --root . --out dashboard.html
```

It prints the written path and defaults to `dashboard.html` at the
repository root (`--root`, default the current directory) when `--out` is
omitted. The command is a one-shot, read-only pass: no server, no
watcher, no daemon, and it never modifies anything under `.aios/`.
`dashboard.html` is git-ignored.

The page opens with a plain-language introduction to AIOS and its Task ->
Review -> Approval loop, then an overview (project, Task counts per state,
generation time), a "Next actions" section (a plain-language, plain-array
list of what needs a decision — awaiting approvals, blocked Tasks, pending
plan adoptions — or an explicit empty state when nothing needs action),
"Upcoming Tasks" and "Completed Tasks" sections (one card per Task with its
id, title, a state badge, retry count/limit, `approval`, its latest Review
id/verdict with the Review's findings in a collapsible section, and its
recorded Attempt count; the done section is visually distinguished with a
checkmark label, not color alone), and a "Plan proposals awaiting adoption"
section listing each not-yet-adopted plan's id, profile, and proposal count.
A separate "Plan Progress" section shows every adopted plan's ordered Tasks,
done count, and current Task. Its current-state labels and operator action are
derived live from the same progression library used by `aios progress`; only
durable approval, blocked, and invalid-document states are classified. When a
Task has no such durable marker, the section may show the latest failed or
capacity-deferred Worker session in a clearly separate "Last observed"
historical area, without presenting that possibly stale evidence as current or
attaching an action to it. Transient cancellation and repository-conflict
events are intentionally not reconstructed after the command exits.
A Task in `state: approval` whose decision file `.aios/approvals/<task-id>`
does not yet exist is flagged with the exact path a human must write
`approved` or `rejected` to. Tasks, Reviews, and plan documents are loaded
with the same strict validation the Loop Engine uses; a document that fails
to load is rendered as a visible error card naming the document and reason
instead of aborting the whole dashboard. A separate Worker Sessions section
shows the operational ledger's usage and refill information; a missing
ledger is an empty state and an invalid one is a visible error. The layout
uses landmark regions, a correct heading hierarchy, and CSS-only responsive
collapsing to a single column at narrow widths. The HTML uses inline CSS
only and needs no JavaScript for its core view.

## Operate Other Repositories from One AIOS Checkout

AIOS itself stays in one source checkout on the operator's computer. It is not
copied into every product repository. The target keeps only its own durable
workflow evidence (`.aios/tasks/`, Reviews, approvals, and plans) plus ignored
machine-local execution state. Run the central CLI with `--root` to select the
repository it should operate on.

From the AIOS checkout, bootstrap a target Git working tree:

```console
npm run aios -- init --root ../product-repo --from ../local-config/assignments.json
```

`init` accepts a direct `.git` directory or worktree `.git` file, validates the
entire target and the supplied `aios.assignments/v1` or `aios.routing/v1`
configuration before its first write, and idempotently ensures
`.aios/tasks/`, `reviews/`, `results/`, `approvals/`, and `runtime/`. It also
creates `.aios/.gitignore` for `runtime/` and `assignments.json`; provider
commands, model catalogs, local adapter paths, sessions, and capacity state
therefore remain machine-local rather than committed project policy.

Every command token containing a path separator must be explicit: an absolute
path must exist, while a relative adapter path must stay inside the target and
name an existing file. AIOS never guesses an adapter location, model name, or
credential. A valid existing configuration and `.gitignore` are preserved,
even when a different `--from` source is supplied. Omitting `--from` prepares
the repository without installing execution configuration. `--check` performs
the same validation and reports `would_create`/`already_present` actions without
writing. Exit codes are 0 for initialized/already initialized/checked, 1 for a
target-state conflict, and 64 for malformed operator input.

Create one planning Task from a natural-language goal:

```console
npm run aios -- brief "Add searchable release history" --root ../product-repo
```

The JSON response names the allocated Task, derived plan id, and project id.
`--plan <id>` and `--project <id>` make either identity explicit; `--check`
resolves the same values without writing. `brief` rejects an uninitialized
target, unsafe Markdown structure, oversized/empty objectives, identity
conflicts, existing plan directories, and Task collisions before creating
anything. On success it writes exactly one approval-required planning Task and
does not launch a Worker. The original Brief is embedded byte-for-byte and the
generated Task limits its Implementer to the selected `plans/<plan-id>/`.

Continue with the unchanged foreground commands, always pointing at the same
target:

```console
npm run aios -- run task-0001 --root ../product-repo
# Inspect the reviewed plan, then write approved or rejected to the reported
# ../product-repo/.aios/approvals/task-0001 path and rerun the same command.
npm run aios -- run task-0001 --root ../product-repo
npm run aios -- adopt plans/add-searchable-release-history --root ../product-repo
npm run aios -- progress plans/add-searchable-release-history --root ../product-repo
npm run aios -- dashboard --root ../product-repo
```

The authority boundary does not change across repositories: Workers may
propose files only in their granted workspace (the generated Planner Task grants
`plans/<plan-id>/`), the engine owns lifecycle writes under `.aios/`, a human
owns approval decision files, and only an explicit operator `adopt` command
turns proposals into real Tasks. None of `init`, `brief`, `adopt`, or
`dashboard` starts a background service. A hand-prepared repository that never
ran `init` remains compatible with `run` and `dashboard` as long as its existing
documents and local Assignment configuration are valid.

The committed disposable proof is runnable without provider capacity or
network access:

```console
node fixtures/cross-repo-demo.js
```

It creates a scratch repository with a different project identity, runs
`init -> brief -> planning Review/Approval -> adopt -> progress -> dashboard`
through the public CLI and deterministic fake Workers, verifies every artifact
is in the scratch repository and the AIOS checkout is byte-for-byte unchanged,
then removes the scratch directory.

## Planner

Planner is an upstream convention, not a fourth engine Role and not a
multi-Task scheduler. A normal planning Task uses its Implementer to turn one
brief into proposals under `plans/<plan-id>/`; its Reviewer evaluates both the
mechanical validity and the quality of that decomposition. Workers may write
the plan directory, but only the operator-invoked engine command below may
materialize proposals under `.aios/tasks/`.

Every Planner follows the same protocol: preserve the brief, state assumptions
and risks, select measurable completion evidence, keep each proposal within one
focused Worker session, and put ordering in the plan rather than adding Task
dependency fields. A profile supplies domain-specific decomposition and
verification guidance without granting additional authority:

| Profile | Use it for | Planning emphasis |
| --- | --- | --- |
| `generic-goal` | Ambiguous or uncatalogued work | Independently verifiable outcomes; the safe fallback |
| `software-feature` | New product or code behavior | Contracts, implementation, tests, integration |
| `bug-fix` | Regressions and defects | Reproduction, root cause, correction, regression coverage |
| `website` | Multi-page web experiences | Information structure, shared visuals, pages, accessibility |
| `research` | Evidence-backed investigation | Questions, sources, corroboration, synthesis |
| `migration` | Data or platform transitions | Preflight, backup, conversion, validation, rollback |
| `content` | Written deliverables | Audience, outline, draft, fact-checking, editing |

Choose the narrowest profile supported by the brief. When none clearly fits,
choose `generic-goal` and explain the decomposition rules in the plan. Profile
selection is reviewable evidence, so `PLAN.md` begins with exact front matter:

```markdown
---
schema: aios.plan/v1
id: public-site
project: example-project
profile: website
profile_reason: The brief requests a responsive multi-page public website.
---

# Public site plan

## Brief

The original goal and constraints.

## Profile Application

How the selected profile shaped this decomposition.

## Assumptions and Risks

What is assumed, what remains uncertain, and what could invalidate the order.

## Decomposition Rationale

Why these are one-session Tasks and why this order is appropriate.

## Execution Order

1. P-01 establishes the shared foundation.
2. P-02 delivers the first page.
```

The same directory contains a contiguous `P-01.md`, `P-02.md`, and so on.
Each proposal is an ordinary `aios.task/v1` document except that its id is the
matching placeholder. It starts in `implement`, uses `retry: {count: 0,
limit: 2}`, has `last_review: null`, and cannot refer to other proposals in its
body; relationships stay in `PLAN.md`.

The planning Implementer's Verification must run the non-mutating check:

```console
npm run aios -- adopt plans/public-site --check
```

After the planning Task passes Review and any required human approval, adopt
the reviewed plan explicitly:

```console
npm run aios -- adopt plans/public-site
```

`adopt` validates the profile evidence, sections, ordered references, and every
proposal before writing anything. It allocates sequential real Task ids after
the repository's greatest existing id, creates all Tasks without overwriting
existing files, rewrites the placeholders in `PLAN.md`, and prints the mapping.
Validation failure names all detected problems and writes nothing. `--root`
changes the repository root; the plan must be a direct child of its `plans/`
directory. Exit codes are 0 for checked/adopted, 1 for plan validation or
adoption failure, and 64 for command usage errors. Running the adopted Tasks is
deliberately separate; orchestration remains out of scope.

## Adaptive Routing and Bounded Dispatch

`src/routing.js` defines configuration and workload evidence,
`src/routing-policy.js` performs pure selection, `src/routing-ledger.js` stores
durable decisions and audit events, and `src/routing-dispatch.js` connects the
selected candidate to the existing `CommandWorker`. `aios.assignments/v1`
keeps its legacy Role-only behavior. Adaptive execution activates only when the
input schema is explicitly `aios.routing/v1`.

An `aios.routing/v1` document declares all model information as operator data:

- ordered `tiers` with unique positive ranks;
- declared `capabilities`, `cost_classes`, and `latency_classes` catalogs;
- `candidates` with a stable id, provider/model ids, tier, eligible Roles,
  shell-free command argv, enabled state, context limit, capabilities, and
  cost/latency class;
- `policy` with the high tier, distribution window and positive provider
  weights, bounded fallback/escalation limits, and default budgets;
- optional provider-neutral `hints`, selected by exactly one Task or adopted
  plan, that declare work kind, complexity, risk, capabilities, verification,
  and budgets; and
- optional candidate-id `overrides` selected by Task/wildcard and Role, each
  declaring `allow_fallback` explicitly. They are applied at selection time
  with the precedence rules documented under "Operating adaptive routing".

The parser is strict at every object level and reports the exact path of unknown
fields. Model names and capabilities are never inferred from strings or fetched
from a provider. Candidate commands remain argv arrays and cannot introduce
shell interpolation, credentials, or hidden environment configuration.

`buildWorkloadContext` produces immutable, provider-neutral evidence. Its
deterministic rules are:

- Planning is recognized only by an explicit `work_kind: planning` hint or by
  all three parts of a plan-only contract: an affirmative Objective line starts
  with Produce/Create/Write/Deliver/Generate/Author and names a plan or proposals
  under `plans/<id>/`, a single Constraints list item says the Implementer
  writes only under that exact directory, and one inline verification command is exactly
  `node src/cli.js adopt plans/<id> --check` or
  `npm run aios -- adopt plans/<id> --check`. A title containing "plan",
  separated command fragments, a different directory, or negative write prose
  does not qualify.
- Adopted parent discovery reuses the existing plan header, required-section,
  Execution Order, Task, and project validation. No matching parent is recorded
  as normal standalone uncertainty; multiple matches, a malformed plan, or an
  invalid profile is safety-critical and closes the lower-tier gate. An
  Execution Order mixing proposal `P-##` and adopted `task-####` ids is treated
  as malformed rather than silently skipped, and plan matches/errors are sorted
  so filesystem enumeration cannot change normalized evidence.
- Task context is measured as UTF-8 bytes with an inspectable token estimate of
  `ceil(bytes / 4)`: at most 8,000 bytes is `small`, at most 32,000 is `medium`,
  and anything larger is `large`.
- Without an explicit hint, structural complexity is `high` at eight Acceptance
  Criteria items, five Constraints items, or more than 12,000 bytes; `medium` at
  four criteria, two constraints, or more than 5,000 bytes; otherwise it is
  `low`. Missing work kind, risk, capabilities, or objective verification stays
  explicitly unknown rather than being inferred from prose.
- Evidence precedence is fail-closed: malformed Review/session history, a
  nonzero Task retry, a changes-requested Review, or a failed session makes risk
  high; `approval: required` also makes risk high even when a hint claims low
  risk. Conflicting planning evidence becomes unknown. Defaults never override
  these facts.
- The minimum tier is the configured high tier unless every lower-tier gate
  passes. The exact pass case is an Implementer (not Reviewer), explicit
  non-planning implementation hint, low complexity, low risk, small/medium
  context, explicitly known capabilities, objective verification, no required
  approval, no retry or unresolved failure, and no safety-critical uncertainty.
  Every failed gate is returned as a stable rejection reason.

The normalized context labels the source of Task/Role identity, work kind,
parent plan, complexity, risk, context size, capabilities, verification,
budgets, approval/retry, history, uncertainty, minimum tier, lower-tier reasons,
and diagnostics. Supplied Reviews must be valid `aios.review/v1` documents with
non-empty bodies; supplied sessions must be validated `aios.sessions/v1` ledger
rows. Invalid history is recorded in diagnostics and forces the high tier rather
than being ignored.

### Deterministic selection and decision ledger

`selectCandidate` has no I/O, clock, randomness, Worker launch, or model call.
Its complete input is the validated catalog, normalized workload, exact
Task/Role/attempt/policy-revision key, prior decision history, and (for review)
the Implementer decision. Candidate and provider tie breaks use a stable
codepoint order, so host locale does not affect the result.

The selector first removes disabled, Role-ineligible, previously attempted,
capability/context-inadequate, over-budget, and below-minimum-tier candidates.
Planning, unknown or conservative work stays at the configured high tier; only
a bounded Implementer workload whose lower-tier gates all passed can use its
lower minimum. A Reviewer is never below the Implementer tier and prefers a
different provider. When no cross-provider candidate survives, the recorded
same-provider exception includes the rejected alternatives and their exact gate
reasons.

After the hard gates, a documented lexicographic tuple prefers a different
Reviewer provider, then the minimum sufficient tier and capabilities, then
lower latency and cost. Provider distribution is considered only among
candidates with the identical best tuple. Finite-window target deficits use
exact integer/rational arithmetic; the audit form stores reduced numerator and
denominator strings, avoiding floating-point routing drift. Provider id and
candidate id resolve exact ties. The returned step, parent step, fallback
availability, and per-Task escalation usage are explicit and bounded by policy.
Task/plan hint provenance must identify the current Task or normalized parent,
exist in the active configuration, and agree field-for-field with the workload.
The selector recomputes the complete ordered lower-tier rejection list rather
than trusting a supplied eligibility flag. Reviewer comparison likewise binds
the supplied Implementer candidate, provider, and tier back to the catalog.
Prior decisions use one closed projection containing the exact key, step,
candidate/provider pair, and normalized fallback reason. Before any count is
used, the selector checks the current catalog relationship, Role eligibility,
one policy revision per action, unique candidates and steps, and contiguous
step order across every history key.

### Sequential recovery in the Role loop

For every Implementer or Reviewer action, the file resolver re-reads the routing
configuration, hashes the validated policy into the exact decision key, builds
the current workload, and persists the selected candidate before launch. The
candidate's declared argv still runs through `CommandWorker`, so Task stdin,
Result validation, session telemetry, timeouts, cancellation, Review projection,
retry limits, and Approval behavior retain their existing authority. The human
Approver is deliberately outside model routing and uses
`workers/human-approver.mjs`.

Recovery is sequential. Capacity, timeout, and typed provider failures first
try one unused candidate at the same tier from another provider; only then may
selection move upward. `verification_failed`, `context_insufficient`, and exact
duplicate-Attempt evidence require a strictly higher tier. A failure Result
without `failure_kind` remains an ordinary Worker failure and is never guessed
into a route. Candidate ids cannot repeat within an action, so a route cannot
cycle. Provider continuations stay with the capacity-deferred candidate; a
fallback always starts with a null continuation.

Every policy must declare positive finite `fallbacks_per_action` and
`escalations_per_task` bounds. Repository tests use small limits of three
fallbacks and two escalations; operators should keep production values similarly
small because each edge can start another paid foreground session. The decision
ledger records launch, capacity pause, classified failure, fallback/escalation
edge, completion, and exhaustion events. Session ids are linked when available,
while usage and cost remain solely in the session ledger.

`RoutingDecisionLedger` persists strict `aios.routing-decisions/v1` JSON at
`.aios/runtime/routing-decisions.json` with atomic replace and snapshot
compare-and-swap checks. A decision is recorded before dispatch by its exact
key and step. Re-recording the identical normalized decision is an idempotent
no-op; changing any recorded field or mixing policy revisions fails closed.
An exclusive repository-local lock encloses the final snapshot comparison and
atomic replace, so overlapping writers cannot both pass the comparison; a
snapshot whose projected fields do not match its raw bytes is also rejected.
Initial state must be `selected`, dispatch must precede a terminal outcome, and
an override attaches only before dispatch. State and timestamps move only
forward, and ledger `updated_at` must equal the latest decision observation.

Ledger rows contain only normalized workload evidence, ordered candidate gate
results, the choice and fitness tuple, exact distribution evidence, optional
normalized failure/override data, state, event/session relationships, and
caller-supplied timestamps. They exclude command argv, environment, Task/prompt
bodies, credentials, continuation values, and raw provider errors. Diagnostics
have a small reason-code vocabulary, are length-bounded, and redact common
secrets and local user paths. Read APIs resolve an exact key, find the latest Task/Role
decision, count a bounded provider window, and produce a sanitized dashboard
projection. Missing state is empty; malformed or conflicting state is never
overwritten automatically.

Provider model ids are bounded identifier-like data, not free-form text. On
load, the ledger also rechecks workload enums, fixed gate ordering, positive
distribution targets, provider uniqueness, count totals, exact rational
deficits, equivalent-provider coverage, winner-change claims, same-provider
review evidence, and override/choice agreement. A structurally valid JSON file
with inconsistent audit facts is therefore malformed state, not trusted history.
Credential-, token-, URL-, and local-path-shaped model ids are rejected at both
catalog and ledger boundaries. The ledger stores bounded planning/history
diagnostic counts, recomputes lower-tier rejection evidence, replays each
finite distribution window from the actual preceding rows, and verifies that
the greatest-deficit provider plus lowest candidate id produced the recorded
winner. Self-consistent but fabricated counts therefore fail both load and
record operations.

### Operating adaptive routing

AIOS has two execution modes, chosen only by the schema of the configuration
file that `--assignments` points to (default `.aios/assignments.json`):

- **Legacy Assignment mode** (`aios.assignments/v1`) maps each Role to one
  command. It is the compatibility mode: it produces the same Worker, stdout,
  exit codes, Task transitions, session records, and capacity behavior as
  before routing existed, and it never writes a routing ledger.
- **Adaptive routing mode** (`aios.routing/v1`) selects an Implementer or
  Reviewer candidate per Task action. The human Approver always remains
  outside model routing.

Model availability, pricing, capability, and naming are operator-maintained
configuration, not source-code truth: the engine never ships, infers, or
fetches a model list, and nothing in this repository promises that any named
commercial model is currently available. Replace the placeholder `model` ids
and worker commands below with whatever your local Claude/Codex adapters
accept today. Never put credentials, tokens, URLs, or user-local paths into
`model` ids or anywhere else in the file; the validators reject
credential-shaped values.

```json
{
  "schema": "aios.routing/v1",
  "tiers": [
    { "id": "lower", "rank": 1 },
    { "id": "high", "rank": 2 }
  ],
  "capabilities": ["filesystem"],
  "cost_classes": ["economy", "standard"],
  "latency_classes": ["standard"],
  "candidates": [
    {
      "id": "claude-high",
      "provider": "claude",
      "model": "your-claude-high-model-id",
      "tier": "high",
      "roles": ["implementer", "reviewer"],
      "command": ["node", "workers/claude-worker.mjs"],
      "enabled": true,
      "context_limit": 200000,
      "capabilities": ["filesystem"],
      "cost_class": "standard",
      "latency_class": "standard"
    },
    {
      "id": "codex-high",
      "provider": "codex",
      "model": "your-codex-high-model-id",
      "tier": "high",
      "roles": ["implementer", "reviewer"],
      "command": ["node", "workers/codex-worker.mjs"],
      "enabled": true,
      "context_limit": 200000,
      "capabilities": ["filesystem"],
      "cost_class": "standard",
      "latency_class": "standard"
    },
    {
      "id": "claude-lower",
      "provider": "claude",
      "model": "your-claude-lower-model-id",
      "tier": "lower",
      "roles": ["implementer"],
      "command": ["node", "workers/claude-worker.mjs", "--small"],
      "enabled": true,
      "context_limit": 64000,
      "capabilities": ["filesystem"],
      "cost_class": "economy",
      "latency_class": "standard"
    }
  ],
  "policy": {
    "high_tier": "high",
    "distribution_window": 20,
    "provider_targets": [
      { "provider": "claude", "weight": 1 },
      { "provider": "codex", "weight": 1 }
    ],
    "limits": { "fallbacks_per_action": 2, "escalations_per_task": 2 },
    "default_budgets": { "cost": "standard", "latency": "standard" }
  },
  "hints": [
    {
      "selector": { "task": "task-0012", "plan": null },
      "work_kind": "implementation",
      "complexity": "low",
      "risk": "low",
      "required_capabilities": ["filesystem"],
      "verification": "objective",
      "cost_budget": "economy",
      "latency_budget": "standard"
    }
  ],
  "overrides": [
    {
      "selector": { "task": "*", "role": "reviewer" },
      "candidate": "codex-high",
      "allow_fallback": true
    }
  ]
}
```

The operating rules an operator relies on:

- **Capability tiers and the Planner invariant.** `tiers` is a strict order.
  A planning Task — recognized by an explicit `work_kind: planning` hint or
  the strict plan-only Task contract — always requires `policy.high_tier`.
  No cheaper candidate, provider deficit, or override can select a
  lower-tier candidate for planning; the audit row records the lower
  candidate's `tier_below_minimum` hard-gate rejection.
- **Lower-tier eligibility.** A lower tier is possible only for a bounded
  Implementer action whose evidence all passes: an explicit implementation
  hint, low complexity, low risk, small/medium context, explicit
  capabilities, objective verification, no approval requirement, and no
  retry/failure history or safety-critical uncertainty. Anything unknown
  stays at the high tier.
- **Reviewer rules.** A Reviewer is never below the recorded Implementer
  tier (and never below the high tier), and a different provider is
  preferred. A same-provider Review is recorded as an explicit exception
  with each cross-provider candidate's rejection reasons.
- **Distribution is fitness-first.** Provider weights redistribute work only
  among candidates whose entire fitness tuple is identical after every hard
  gate; a deficit never restores a rejected candidate or beats a better
  tuple. Ties resolve deterministically by provider then candidate id.
- **Decision keys and audit.** Every action is keyed by
  Task/Role/attempt/policy-revision and persisted before dispatch in
  `.aios/runtime/routing-decisions.json`. Re-running the same action reuses
  the recorded candidate; the choice does not drift as the window fills.

### Routing overrides from the CLI

`aios run` and `aios progress` accept a repeatable
`--route-override <task-selector>:<role>=<candidate-id>` flag (quote the value
so the shell does not expand `*` or split on `:`):

```console
npm run aios -- run task-0004 --route-override "task-0004:implementer=codex-high"
```

Precedence is: exact Task selector before `*`, and a CLI override before a
configured override at equal specificity (the displaced configured candidate
is preserved as audit evidence). An override displaces only cost/latency and
distribution preference; every hard safety gate still applies, so an unsafe
Planner or Reviewer downgrade fails closed before any Worker launch, naming
each violated gate. A CLI override pins its candidate and denies fallback for
the whole action; a configured override declares `allow_fallback` explicitly.
Overrides are rejected with the legacy `aios.assignments/v1` schema.

### Recovery order, limits, and continuation safety

When a routed Worker fails, recovery is sequential and bounded by
`policy.limits`:

1. **Capacity, timeout, provider failure** first try one unused candidate at
   the same tier from the other provider; promotion happens only when no
   same-tier cross-provider candidate remains.
2. **Typed `verification_failed`/`context_insufficient` failures and exact
   duplicate-Attempt evidence** escalate directly to a strictly stronger
   unused candidate.
3. A rejected Review consumes the Task's normal retry; the next attempt's
   selection observes that history (risk becomes high, so the choice rises),
   and routing never resets or extends `retry.limit`.
4. When the per-action fallback or per-Task escalation limit is exhausted —
   or a fallback-denying override blocks recovery — the run ends in the
   documented halted outcome with an `exhausted` audit event rather than
   retrying any candidate.

Capacity recovery is continuation-safe: a provider continuation token resumes
only the exact candidate that issued it. When capacity defers and an
equivalent cross-provider candidate exists, the fallback starts a fresh
session with a null continuation; a foreign continuation is never sent across
providers. When no fallback exists, the existing `--wait-for-capacity`,
`--max-capacity-wait-ms`, and `--max-capacity-pauses` behavior applies
unchanged to the same candidate.

### Reading the routing dashboard

`aios dashboard` renders the routing ledger read-only next to Task and session
evidence. The routing section shows, per Task/Role action: the chosen
candidate/provider/model/tier, the workload evidence and its sources, every
considered candidate with its exact hard-gate rejections, the fitness tuple,
the distribution window counts and exact rational deficits, override audit
rows (source, selector, displaced policy winner, rationale), fallback and
escalation edges with their reason codes, exhaustion, and the linked session
ids. A summary compares configured provider target shares against the
observed window. Routing rows are historical audit evidence — the Task's
current state still comes from its Task document, and usage/cost stay in the
session ledger.

### Disabling routing

Return to legacy Assignment mode by replacing the configuration content with
an `aios.assignments/v1` document (or pointing `--assignments` at one). No
other change is needed: dispatch goes back to the fixed per-Role commands and
no new routing decisions are recorded. The existing
`.aios/runtime/routing-decisions.json` remains as immutable history; like the
session ledger it is operational evidence, not Task lifecycle truth, and may
be deleted once it is no longer wanted.

### End-to-end demonstration

A disposable mixed-provider demonstration assembles the whole feature with
fake Claude and Codex command Workers (`fixtures/routing-worker.js`) that
declare explicit provider/model identities but never make a network or paid
call:

```console
npm run demo:routing
```

It creates a temporary AIOS root with a routing configuration, a planning
Task, an adoptable two-proposal plan, and general Tasks; runs the real
`adopt`, `run`, `progress`, and `dashboard` CLI entry points as child
processes; and prints a JSON report of high-tier planning, lower-tier
implementation with cross-provider review, an audited CLI override, capacity
fallback, audit/session correlation, and dashboard rendering. The temporary
root is removed in `finally`, and the report contains no machine-local paths.
The durable equivalents live in `test/routing-e2e.test.js`.

## Command Worker

Commands are launched directly from their argv array with no shell
interpolation. The repository root is their working directory. A Worker:

1. Receives the complete Task Markdown document as UTF-8 stdin.
2. Reads `AIOS_TASK_ID` and `AIOS_ROLE` from the environment when useful.
3. Writes exactly one `aios.result/v1` JSON object to stdout.
4. Writes diagnostic logs only to stderr.

A session-aware command adapter may instead write one strict
`aios.worker-execution/v1` transport envelope containing either its Result or
a capacity deferral plus session telemetry. `CommandWorker` records and
unwraps that envelope, so the Loop Engine still sees `execute(Task) -> Result`.
Other command Workers remain unchanged.

On Windows, `.cmd` and `.ps1` shims are intentionally not opened through an
implicit shell. Name a safe interpreter explicitly, for example:

```json
["powershell.exe", "-NoProfile", "-NonInteractive", "-File", "C:\\workers\\worker.ps1"]
```

Node-based wrappers can likewise use `["node", "C:\\workers\\worker.js"]`.

A nonzero exit, timeout, malformed Result, missing Assignment, or Task change
during execution halts the run without an engine-authored Task transition or
retry increment. External Worker changes elsewhere in the repository are not
rolled back; an operator must inspect them before explicitly resuming.

## Claude Code Workers

`workers/claude-worker.mjs` binds a Role to one non-interactive Claude Code
session. It follows the command Worker contract: Task document on stdin,
`AIOS_ROLE`/`AIOS_TASK_ID` in the environment, and one structured execution
envelope on stdout. It consumes Claude Code NDJSON events. The session's
JSON-only reply becomes the Result payload; a reply of
`{"failure_reason": "..."}` becomes a `status: failure` Result. A Worker may
also add `"failure_kind":"verification_failed"` or
`"failure_kind":"context_insufficient"` to request bounded routed escalation;
anything structured but unusable becomes a telemetry-bearing failure Result. Malformed
transport output exits nonzero. Both paths halt without a Task transition.

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "implementer": ["node", "workers/claude-worker.mjs", "C:\\path\\to\\claude.exe"],
    "reviewer": ["node", "workers/claude-worker.mjs", "C:\\path\\to\\claude.exe"]
  }
}
```

The trailing argument (or `AIOS_CLAUDE_CLI`) names the Claude executable;
required on Windows when `claude` resolves to a `.ps1`/`.cmd` shim, because
Workers are spawned without a shell. `AIOS_CLAUDE_MODEL` overrides the
model alias (default `sonnet`).

Permission model: the Implementer session runs with `acceptEdits` and Bash
allowed; it is the one Role meant to change the repository. Reviewer and
Approver sessions keep the default non-interactive permissions, where only
read-only tools plus `npm test` work. Prompts additionally forbid every
session from touching `.aios/` or git history; the engine's conflict
detection halts the run if a Worker modifies the active Task anyway.

The adapter maps only Claude Code's structured `rate_limit_event` with
`status: rejected`, numeric `resetsAt`, and `session_id` to a capacity
deferral. It does not parse error prose. A resumed invocation receives the
opaque continuation through `AIOS_WORKER_CONTINUATION` and uses that exact id
with `--resume`. Final usage and cost plus the latest structured utilization
and reset are copied into the session ledger.

Caveats: each Role action starts a fresh session unless it is resuming a
capacity pause, and each active invocation bills usage. An Implementer session
executes with your local permissions; assign it only to repositories you trust
it to edit, and raise `--timeout-ms` (Sprint 0 default 300000) for real work.

## Codex Workers

`workers/codex-worker.mjs` binds a Role to one non-interactive OpenAI Codex
(`codex exec`) session, interchangeable with `workers/claude-worker.mjs`
through Assignment configuration alone: both adapters use the same Role
prompts, the same reply extraction and payload validation (shared in
`workers/worker-shared.mjs`), and the same failure discipline. It follows the
command Worker contract: Task document on stdin, `AIOS_ROLE`/`AIOS_TASK_ID`
in the environment, and one `aios.worker-execution/v1` transport object on
stdout containing the Result plus session telemetry.

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "implementer": ["node", "workers/codex-worker.mjs", "C:\\path\\to\\codex.exe"],
    "reviewer": ["node", "workers/codex-worker.mjs", "C:\\path\\to\\codex.exe"]
  }
}
```

The trailing argv tokens (or `AIOS_CODEX_CLI`) name the Codex launcher — one
or more tokens, so both a native binary path and a portable
`["node", "C:\\path\\to\\cli.js"]` pair work. `AIOS_CODEX_MODEL` is passed as
`--model` when set; otherwise the CLI's configured default model is used.

On Windows, the PATH entry `codex` typically resolves to a PowerShell shim
(`codex.ps1`/`codex.cmd`), and Workers are spawned without a shell, so name
the real launcher explicitly — the vendored native `codex.exe`, or `node`
plus the portable `cli.js` — exactly as with the `.cmd`/`.ps1` caveat
documented above for other command Workers.

Sandbox mapping: each Role action launches exactly one `codex exec` session
with `--json` and `--sandbox workspace-write` for the Implementer (the one Role
meant to change the repository) or `--sandbox read-only` for the Reviewer and
Approver. The `--dangerously-*` bypass flags are never used. On a continuation
the adapter runs `codex exec ... resume <thread-id> <prompt>` and requires the
resumed `thread.started.thread_id` to equal that exact id.

The reply is read deterministically from a temporary
`--output-last-message` file, which is removed after each session regardless
of outcome. A valid role payload becomes a `status: success` Result, a
`{"failure_reason": "..."}` reply becomes a `status: failure` Result. It may
include the same closed `failure_kind` values described for Claude when routed;
a parseable Codex session failure becomes an ordinary failure Result so its
thread and usage telemetry are still recorded. Malformed JSONL or a stream
without a thread id makes the adapter exit nonzero with no stdout.

Capacity investigation (Codex CLI 0.144.3): `codex exec --json` exposes the
resumable id in `thread.started.thread_id` and token counts in
`turn.completed.usage`, but its public event schema has no reset-time or
rate-limit field. A real usage-limit trace captured in
`fixtures/codex-usage-limit.ndjson` contains only `error.message` and
`turn.failed.error.message`; the apparent reset time is human prose. The
fixture source is this [published raw Codex execution
trace](https://gist.github.com/konard/4b15728ce4ff3cddb6ea482a43e32c4c),
and the absence of capacity fields agrees with the [Codex exec event
schema](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs).
On a failed turn, the adapter now starts the same Codex launcher's official
app-server transport and asks for two independent structured records:
`thread/resume` must report `codexErrorInfo: "usageLimitExceeded"` for the
exact failed thread, and `account/rateLimits/read` must report a rejected,
exhausted Codex rate window with a future Unix `resetsAt`. If multiple windows
are exhausted, AIOS waits for the latest reset. Only that corroborated case
becomes a capacity deferral using the exact thread id as its continuation.

The adapter still never parses error prose, token counts, local rollout files,
or hard-coded quota windows to invent `retry_at`. Missing app-server support,
an unreadable thread, a stale or absent reset, credit-only exhaustion, and all
non-usage errors remain ordinary failures for operator inspection. Claude's
structured deferral behavior is unchanged.

Mixed-vendor example — bind different Roles to different providers in one
Assignment file:

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "implementer": ["node", "workers/codex-worker.mjs", "C:\\path\\to\\codex.exe"],
    "reviewer": ["node", "workers/claude-worker.mjs", "C:\\path\\to\\claude.exe"],
    "approver": ["node", "workers/human-approver.mjs"]
  }
}
```

## Human Approver Worker

`workers/human-approver.mjs` binds the `approver` Role to a human operator
instead of a session. It follows the command Worker contract: Task document
on stdin, `AIOS_ROLE`/`AIOS_TASK_ID` in the environment, one
`aios.result/v1` object on stdout.

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "approver": ["node", "workers/human-approver.mjs"]
  }
}
```

Decision file protocol: the worker reads
`.aios/approvals/<task-id>` (relative to the repository root) and never
writes to it — only the operator does. The file's content, with
surrounding whitespace ignored, must be exactly `approved` or `rejected`;
anything else yields a `status: failure` Result quoting the invalid
content.

Halt-then-resume flow for a Task with `approval: required`: once a Task
reaches its approval gate, run the engine as usual. Before the file exists,
the worker returns a `status: failure` Result whose reason names the exact
path to create and the two accepted contents, so the run halts for
operator recovery without an engine-authored Task transition or retry.
The operator inspects the Task and repository, writes `approved` or
`rejected` to `.aios/approvals/<task-id>`, and reruns
`aios run <task-id> --assignments ...` — the engine re-invokes the
approver Worker, which now reads the decision and lets the loop continue.

## Attempt Frames

The engine wraps every Attempt it appends to a Task in an HTML-comment frame
that is invisible in rendered Markdown:

```markdown
<!-- aios:attempt-frame v1 number=1 summary=24 verification=31 -->
### Attempt 1

#### Summary

...
<!-- /aios:attempt-frame v1 number=1 -->
```

`summary` and `verification` are the lengths of the framed text in UTF-16
code units (JavaScript string lengths), measured after normalizing line
endings to LF. The engine locates Attempt content by these offsets instead
of parsing prose, so Result text that merely looks like an Attempt heading
cannot spoof the projection. Frames are load-bearing on read: do not
hand-edit a framed Attempt. Attempts written before framing existed remain
readable as long as they precede the first frame.

Line endings: `.gitattributes` pins the repository to LF, and both frame
measurement and parsing operate on an LF-normalized view, so a checkout or
editor that materializes CRLF keeps framed Tasks readable.

## Limits

Sprint 0 assumes one foreground Loop Engine. It does not guarantee exactly-once
external side effects after a process crash. Review-first persistence and
orphan recovery protect the Task/Review control documents, while broader
scheduling and concurrency remain future requirements. Capacity continuation
also requires the foreground process to remain alive; there is no daemon, OS
wakeup, or reboot-safe session resume.

## Roadmap

Sequential inter-Task progression is implemented: `aios progress` advances the
ordered real Tasks in one adopted plan through the existing single-Task Loop
Engine, resumes from repository state, and stops safely at Approval, capacity,
blocked, failure, cancellation, or conflict boundaries. It remains an explicit
foreground command, not concurrent scheduling or a daemon.

The follow-on milestone is adaptive model routing. Once sequential progression
is reliable, AIOS should evaluate each Task and Role using explicit evidence
such as Planner profile, complexity, risk, context size, tool requirements,
verification burden, latency, and cost budget, then choose from an explicit
Claude-and-Codex candidate pool. Fitness comes first, but equivalent candidates
follow a configurable distribution target so assignments do not drift toward a
single provider; Implementer and Reviewer should use different providers when
both are eligible. Capacity, timeout, and provider failures use a declared
cross-provider fallback. The current Role-only Assignment resolver will need a
Task-and-Role-aware policy layer, while Task documents remain provider-neutral.
Operator overrides and an auditable record of the chosen provider/model,
alternatives, rationale, fallback, and distribution effect are required. Model
routing remains separate from `task-0017` so workflow correctness and routing
quality can be verified independently.
