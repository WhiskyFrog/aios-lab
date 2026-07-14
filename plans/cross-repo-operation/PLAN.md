---
schema: aios.plan/v1
id: cross-repo-operation
project: aios-lab
profile: software-feature
profile_reason: Cross-repository bootstrap and brief intake add two new operator-facing CLI capabilities whose main risks are fail-closed target-state contracts, a consistent command surface, safety boundaries around writing into repositories AIOS does not own, and end-to-end verification that the unchanged loop drives a foreign repository. The software-feature profile's contracts, implementation, tests, and integration emphasis fits those risks more narrowly than generic-goal.
---

# Plan cross-repository bootstrap and brief intake

## Brief

Let an operator point AIOS at any other repository and start work with a
single natural-language objective. The engine, progression, dashboard, and
adoption commands already accept `--root`, `CommandWorker` already runs
Workers in that root, and the Planner convention already turns one brief into
an adopted plan; what is missing is the entry point. Two gaps close it: an
`init` capability that bootstraps a target repository's `.aios/` operating
state — the layout the engine, dashboard, and progression already expect,
plus machine-local worker assignment (or routing) configuration — and a
`brief` capability that materializes one operator objective as exactly one
valid planning Task in the target's `.aios/tasks/`, scoped to the existing
Planner protocol and profile table. Neither capability dispatches a Worker,
spends provider capacity, or modifies existing Tasks. After `init` and
`brief`, the existing `run`, `adopt`, `progress`, and `dashboard` commands
drive the target repository end to end via `--root`, and existing
single-repository usage without `init` remains valid. A daemon, concurrent
scheduling, provider SDKs, network services, and automatic dispatch of paid
sessions stay out of scope.

## Profile Application

The `software-feature` profile separates contracts, implementation, tests,
and integration; four boundaries shape this decomposition:

- **Contracts and target evidence.** Both commands share one deterministic,
  fail-closed classification of a candidate target: whether it is a
  repository root, whether `.aios/` is absent, already initialized, or in a
  conflicting state, how a project id and plan id are resolved, and what
  makes an objective acceptable (non-empty, bounded size, and structurally
  safe to embed verbatim). These rules are pure inspection with no writes,
  so they are specified and tested first, before any command can act on
  them. Every rejection produces a distinct error naming its exact cause and
  leaves the target untouched.
- **CLI surface.** `init` and `brief` join the existing subcommand family
  with the same conventions: `--root` selects the target, a no-write
  `--check` mode mirrors `adopt --check`, exit codes follow the adopt
  pattern (0 success or check passed, 1 target validation failure, 64 usage
  error), and output is a single structured report. Each command is its own
  focused Task because each owns a different write boundary.
- **Safety boundaries.** `init` validates everything before its first write,
  is idempotent, never overwrites existing operator state, and confines
  machine-local configuration so committed documents in the target stay
  provider-neutral with no user-local paths or secrets. `brief` creates
  exactly one Task document with an exclusive atomic write, defaults it to
  `approval: required`, and its generated wording grants the Planner no
  authority beyond the existing convention: proposals still become Tasks
  only through operator-invoked adoption. Neither command dispatches a
  Worker or touches the engine, progression, adoption, or dashboard code
  paths.
- **End-to-end verification.** Unit tests prove each contract and command in
  isolation, but the feature's claim is that the unchanged loop drives a
  foreign repository, so a final Task proves it in a disposable scratch
  repository: bootstrap, submit a brief, run the generated planning Task
  through the real loop, adopt the resulting plan, progress at least one
  adopted Task, and show that documents, reviews, ledgers, and dashboard
  output land in the target rather than in aios-lab.

`generic-goal` was considered and rejected because the brief is not an
open-ended outcome: it is a concrete CLI feature with contract, safety,
compatibility, and integration risks that this profile addresses directly.

## Assumptions and Risks

- A repository root is detected by the presence of a `.git` entry (a
  directory, or a file for worktrees and submodules) directly under the
  target path. No `git` binary is invoked and no new dependency is added.
  Bare repositories are not supported targets and fail closed with a
  distinct error.
- The engine expects `.aios/tasks/` and `.aios/reviews/`, progression and
  the human approver read `.aios/approvals/`, session and routing ledgers
  live under the git-ignored `.aios/runtime/`, and `.aios/results/` holds
  Result evidence. `init` scaffolds exactly this layout. Some directories
  are also created lazily by the engine; scaffolding them anyway makes the
  operating state explicit and keeps `init` honest about what it owns.
- Worker adapter references are machine-local, not repository truth. The
  operator supplies an existing validated `aios.assignments/v1` or
  `aios.routing/v1` configuration file, and `init` copies it into the
  target's `.aios/` only after checking that every argv token containing a
  path separator either is an absolute path that exists or resolves against
  the target root. This keeps adapter locations explicit and
  operator-confirmed rather than guessed from `PATH`. Moving the adapter
  checkout later breaks only that machine-local file, which the operator
  fixes or re-creates; committed documents are unaffected.
- Machine-local configuration must not leak into version control in the
  target. `init` writes a `.aios/.gitignore` covering `runtime/` and the
  assignment/routing configuration file, so Task, Review, and plan documents
  remain the only committed `.aios/` content and stay provider-neutral,
  matching how user-local paths are confined to the assignment configuration
  in this repository. `init` never edits the target's own top-level files.
- No parallel planning pipeline and no new registry are introduced. The
  project id is resolved from evidence: existing valid Task documents in the
  target win; otherwise an explicit `--project` flag; otherwise the
  normalized target directory basename when it satisfies the existing
  project-id pattern. When none applies, `brief` fails closed asking for
  `--project` rather than inventing an identity.
- An objective is preserved verbatim as the generated Task's Brief section.
  A verbatim line that parses as a markdown heading or as an attempt-frame
  marker would corrupt the strict document structure, so such objectives are
  rejected with a distinct error asking the operator to rephrase, rather
  than silently rewritten. An empty (after trimming) or oversized objective
  is likewise rejected before any write; the size ceiling is a single
  documented constant.
- The plan id defaults to a deterministic slug derived from the objective's
  leading words and validated against the existing plan-id pattern, with an
  explicit `--plan` override. A slug that cannot be derived, an existing
  `plans/<plan-id>/` directory in the target, or an allocated Task id whose
  file already exists each fail closed before any write.
- Generated planning Tasks default to `approval: required`, and no
  relaxation flag is offered in the first version: every generated plan
  keeps a human gate, and adoption remains a separate operator-invoked
  command. This is deliberately conservative because `brief` is the moment
  AIOS gains write intent toward a repository it does not own.
- The full loop must stay unchanged. `init` and `brief` are new subcommands
  plus reusable validation helpers; `run`, `adopt`, `progress`, and
  `dashboard` keep their behavior, and a repository prepared by hand today
  keeps working without `init`. Regression tests guard this boundary.
- The end-to-end proof must not depend on paid provider capacity or on
  aios-lab-specific ids or paths. Scripted command Workers driving the real
  engine in a scratch repository demonstrate the loop deterministically; a
  live-provider rehearsal remains an operator option, not a test dependency.

## Decomposition Rationale

Four proposals keep each change independently reviewable within one focused
Worker session. The shared target contracts come first because both commands
depend on the same fail-closed classification, and specifying it as pure
inspection lets every rejection rule be unit-tested without any repository
writes. `init` comes second because `brief` refuses to run against an
uninitialized target; it owns the scaffold, the idempotence and no-overwrite
guarantees, and the adapter portability gate. `brief` is third and owns the
single-document write, the generated planning-Task template, and the wording
that preserves the existing adoption authority boundary. The final proposal
assembles the feature: a disposable scratch-repository demonstration through
the real loop, regression coverage that the existing single-repository
behavior is unchanged, and operator documentation, written last so the
documented surface matches the implemented contracts.

## Execution Order

1. task-0031 defines the shared cross-repository target contracts and fail-closed
   validation rules both commands consume.
2. task-0032 implements `aios init`, scaffolding a target repository's `.aios/`
   operating state and machine-local worker configuration idempotently.
3. task-0033 implements `aios brief`, materializing one operator objective as one
   valid planning Task under the existing Planner convention.
4. task-0034 proves cross-repository operation end to end in a disposable scratch
   repository and documents the operator workflow.
