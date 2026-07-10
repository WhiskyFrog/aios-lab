# Review Document Specification

This directory stores Reviews: the immutable evidence produced when the
`reviewer` Role evaluates an implementation Attempt. A Task references only
its most recent Review by ID in `last_review`; this contract defines the
document behind that ID.

## Storage and Resolution

- Store each Review at `.aios/reviews/<id>.md`.
- Use an ID matching `^review-[0-9]{4,}$`.
- The filename must be the ID plus `.md`, for example `review-0001.md`.
- Resolving a Review ID means reading exactly `.aios/reviews/<id>.md`. There
  is no search and no fallback location.
- Files that do not match the Review filename pattern, such as `README.md`,
  are not Reviews.
- The Loop Engine allocates IDs in strictly increasing numeric order and
  never reuses one. Workers never allocate Review IDs.

## Canonical Shape

```markdown
---
schema: aios.review/v1
id: review-0002
project: aios-lab
task: task-0002
attempt: 1
verdict: changes_requested
---

# Review of task-0002, Attempt 1

## Findings

Why the verdict was reached, in human-readable terms.
```

## Front Matter

All fields are required. A v1 reader must reject unknown fields so additions
are deliberate schema changes. YAML must be parsed with a YAML 1.2 parser,
not with regular expressions.

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Must be exactly `aios.review/v1`. |
| `id` | string | Immutable; must match `^review-[0-9]{4,}$` and equal the filename stem. |
| `project` | string | Must equal the reviewed Task's `project`. |
| `task` | string | Must match `^task-[0-9]{4,}$` and identify the reviewed Task. |
| `attempt` | integer | The Attempt number evaluated; must be `>= 1`. |
| `verdict` | enum | One of `pass`, `changes_requested`. |

The front matter `verdict` is the only machine-readable outcome. The Loop
Engine must never derive a verdict from the body. Reviews never contain an
agent, provider, model, API, CLI, or human identity, the same rule Tasks
follow.

## Body

The body must explain, in human-readable terms, why the verdict was reached.
A `changes_requested` Review must state what has to change so the next
Attempt can address it. Non-blocking findings and recommendations may be
recorded; they never alter the verdict.

## Immutability

A persisted Review is never edited, renamed, or deleted. A wrong verdict is
corrected by the loop itself: the next evaluation produces the next Review.
At most one Review exists per `(task, attempt)` pair.

## Activated Task Checks

`aios.task/v1` deferred `last_review` resolution and verdict validation until
the Review contract existed. With this contract they are mandatory. For a
Task whose `last_review` is non-null:

- The ID must resolve to a Review file as defined above.
- The Review's `task` must equal the Task's `id`, and its `project` must
  equal the Task's `project`.
- The Review's `verdict` and `attempt` must match the Task's state:

| Task state | Required verdict | Required `attempt` |
| --- | --- | --- |
| `implement` or `review` (`retry.count > 0`) | `changes_requested` | `retry.count` |
| `approval` | `pass` | `retry.count + 1` |
| `done` | `pass` | `retry.count + 1` |
| `blocked` with `approval: rejected` | `pass` | `retry.count + 1` |
| `blocked` otherwise | `changes_requested`, with `retry.count == retry.limit` | `retry.count + 1` |

Attempt numbers start at 1, so a Task in `implement` or `review` is working
on attempt `retry.count + 1` and the Review that scheduled it evaluated
attempt `retry.count`.

## Bootstrap Exemption

`review-0001` declares `schema: aios.review/v0`. It was written before this
contract existed, as the evidence for `task-0001`. It is grandfathered: it
carries the same fields with the same meanings, differing only in its
`schema` value, and it participates in resolution and the activated checks
above. It is exempt from the exact-schema rule, must never be rewritten to
conform, and no new `aios.review/v0` document may be created.
