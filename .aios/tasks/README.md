# Task Document Specification

This directory is the source of truth for work managed by AIOS.

Sprint 0 uses one deliberately small workflow:

```text
Implementer -> Reviewer -> Done
     ^             |
     |             v
     +---- changes requested
```

An optional approval step may sit between Reviewer and Done. Assigning its
`approver` Role to a Human worker makes that gate human-operated. This
specification defines only the Task document needed to drive the loop.

## Storage

- Store each Task at `.aios/tasks/<id>.md`.
- Use an ID matching `^task-[0-9]{4,}$`.
- The filename must be the ID plus `.md`, for example `task-0001.md`.
- The front matter `id` is the identity. A path is only its storage location.
- Files that do not match the Task filename pattern, such as `README.md` and
  `TASK_TEMPLATE.md`, are not Tasks.

## Canonical Shape

```markdown
---
schema: aios.task/v1
id: task-0001
project: aios-lab
title: Define the Task document format
state: implement
retry:
  count: 0
  limit: 2
approval: not_required
last_review: null
---

# Define the Task document format

## Objective

Define one stable Task document contract for Sprint 0.

## Acceptance Criteria

- The contract contains the state required by the current loop.

## Constraints

- Do not implement the Loop Engine in this task.

## Context

This is the repository's bootstrap task.

## Attempts

_None yet._
```

The YAML front matter is the machine-owned control plane. The Markdown body is
the human-readable work brief and result history. Lifecycle decisions must
never be inferred from prose or checklist state.

## Front Matter

All fields are required. A v1 reader must reject unknown fields so additions
are deliberate schema changes. YAML must be parsed with a YAML 1.2 parser, not
with regular expressions.

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Must be exactly `aios.task/v1`. |
| `id` | string | Immutable; must match `^task-[0-9]{4,}$`. |
| `project` | string | Stable project ID; must match `^[a-z0-9][a-z0-9-]*$`. |
| `title` | string | Non-empty, human-readable Task title. |
| `state` | enum | One of `implement`, `review`, `approval`, `done`, `blocked`. |
| `retry.count` | integer | Number of review-to-implementation loop-backs already scheduled; starts at `0`. |
| `retry.limit` | integer | Maximum allowed loop-backs; must be greater than or equal to `0`. |
| `approval` | enum | One of `not_required`, `required`, `approved`, `rejected`. |
| `last_review` | string or null | Stable Review ID matching `^review-[0-9]{4,}$`, or `null` before any review. |

Task documents never contain an agent, provider, model, API, CLI, or human
identity. The state selects a permanent Role; a separate Assignment resolves
that Role to the current worker.

| State | Next action | Role |
| --- | --- | --- |
| `implement` | Produce an implementation Result. | `implementer` |
| `review` | Evaluate the latest Result. | `reviewer` |
| `approval` | Make the final approval decision. | `approver` |
| `done` | None; successful terminal state. | None |
| `blocked` | None; operator action is required. | None |

`state` describes the next required action, not whether a worker process is
currently running. Execution leases and presence are outside Sprint 0.

## Markdown Body

The Markdown body must contain a non-empty `Objective` and at least one
observable `Acceptance Criteria` item. `Constraints`, `Context`, and `Attempts`
are included when they carry information. Their order, the H1, and the
`_None._` placeholders in the template are rendering conventions, not engine
state and not validation requirements.

Acceptance criteria use ordinary bullets in the template. Checkboxes may be
used for readability, but their checked state never controls Task completion.
Constraints should make important non-goals explicit. Context should contain
only inputs, facts, and links a worker needs.

`Attempts` is the append-only, human-readable projection of successful
Implementer Results. Reviewer output is stored separately as a Review. The Loop
Engine must not parse Attempt prose to determine whether execution succeeded.

After a successful implementation Result, the engine atomically rewrites the
Task with both the new Attempt and `state: review`:

```markdown
### Attempt 1

#### Summary

What was changed or produced.

#### Verification

What was checked, or `Not run: <reason>`.
```

Attempt numbers start at 1. A worker adapter must return a structured execution
outcome outside this Markdown; the engine appends an Attempt only after that
outcome is successful. The Result envelope is a separate contract and is not
defined by `aios.task/v1`.

Reviewer output belongs in an immutable object under `.aios/reviews/`; the Task
stores only its stable ID in `last_review`. A Review must expose a structured
verdict of `pass` or `changes_requested`. Its document schema and ID-to-file
lookup rule are separate contracts and are not defined here. Until that Review
contract exists, Task validation can check the ID shape but cannot validate the
referenced verdict. The Loop Engine must never derive a verdict from prose.

## Lifecycle

```text
implement --Result persisted--------------------------> review
review ----pass + approval not_required---------------> done
review ----pass + approval required-------------------> approval
review ----changes + retry available------------------> implement
review ----changes + retry exhausted------------------> blocked
approval --approved------------------------------------> done
approval --rejected------------------------------------> blocked
```

For every Reviewer verdict, persist the immutable Review object first. Then
atomically rewrite the Task once with its ID in `last_review` and all matching
state, retry, and approval mutations. A Task must never expose the new Review
reference without its corresponding transition.

For a Review that requests changes:

1. If `retry.count < retry.limit`, increment `retry.count` and set `state` to
   `implement`.
2. Otherwise, leave `retry.count` unchanged and set `state` to `blocked`.

The initial implementation is not a retry. A limit of `2` therefore permits
at most three implementation attempts: the initial attempt and two loop-backs.
Worker transport or execution failures do not consume this counter and do not
change Task state in Sprint 0. They halt the current loop run; an operator must
explicitly resume it. This file contract does not guarantee exactly-once worker
execution after a process crash; Sprint 0 assumes one Loop Engine and operator
recovery.

## Invariants

- `0 <= retry.count <= retry.limit`.
- `last_review`, when non-null, must match `^review-[0-9]{4,}$`. Resolution and
  verdict validation become mandatory when the Review contract exists.
- In `implement` and `review`, `last_review` is `null` exactly when
  `retry.count == 0`. When `retry.count > 0`, it identifies the preceding
  `changes_requested` Review that scheduled the current attempt.
- `state: review` additionally requires a persisted Result for the current
  attempt.
- `state: approval` requires `approval: required` and a passing
  `last_review`.
- `approval: approved` requires `state: done`.
- `approval: rejected` requires `state: blocked` and a passing `last_review`.
- `state: done` requires a passing `last_review` and either
  `approval: not_required` or `approval: approved`.
- `state: blocked` requires either `approval: rejected`, or a
  `changes_requested` `last_review` with `retry.count == retry.limit`.
- `done` and `blocked` are terminal in Sprint 0. Reopening is an operator
  decision outside this workflow.
- Workers receive a Task and return a Result. Only the Loop Engine changes
  front matter, appends accepted Results, and records Review references.
- Persist a Review before atomically updating the Task that references it. An
  orphaned Review is recoverable; a Task pointing to missing evidence is
  invalid once Review resolution is defined.

## Deliberately Omitted

Sprint 0 does not add priority, tags, dependencies, due dates, timestamps,
event history, worker settings, workflow configuration, or execution leases.
Git provides document history. New fields require a new real workflow need and
a schema version change.

The structured Result envelope and Review document contract are intentionally
not specified by this Task format. They are the next required contracts before
the Loop Engine can be implemented without inferring outcomes from prose.
