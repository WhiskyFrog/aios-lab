# Result Envelope Specification

A Result is the structured execution outcome a worker adapter returns to the
Loop Engine after a worker acts on a Task. It is the contract that lets the
engine advance the loop without inferring any outcome from prose.

Results are transient wire objects. Sprint 0 never persists them: this
directory stores no documents and exists only to hold this contract. The
durable projections are made by the engine — a successful implementer Result
becomes an Attempt in the Task, a successful reviewer Result becomes an
immutable Review document, and a successful approver Result becomes the
Task's `approval` value.

## Shape

A Result is one JSON object:

```json
{
  "schema": "aios.result/v1",
  "task": "task-0002",
  "role": "implementer",
  "status": "success",
  "payload": {
    "summary": "What was changed or produced.",
    "verification": "What was checked, or: Not run: <reason>."
  }
}
```

All fields are required. A v1 reader must reject unknown fields so additions
are deliberate schema changes.

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Must be exactly `aios.result/v1`. |
| `task` | string | Must equal the `id` of the Task the worker received. |
| `role` | enum | One of `implementer`, `reviewer`, `approver`; must equal the Role of the Task's current state. |
| `status` | enum | One of `success`, `failure`. |
| `payload` | object | Role-specific on `success` (below); `{ "reason": <string> }` on `failure`. |

Results never contain an agent, provider, model, API, CLI, or human
identity, and never contain a Review ID or Attempt number: the engine
allocates identifiers.

## Success Payloads

`implementer` — the engine appends these verbatim as the next Attempt's
`Summary` and `Verification`, then sets `state: review`, in one atomic Task
rewrite:

```json
{ "summary": "<non-empty>", "verification": "<non-empty>" }
```

`reviewer` — the engine persists an `aios.review/v1` document carrying the
next Review ID, this verdict, and `findings` as its body, then applies the
matching Task transition per the `aios.task/v1` lifecycle:

```json
{ "verdict": "pass" | "changes_requested", "findings": "<non-empty>" }
```

`approver` — the engine sets `approval` and `state` per the `aios.task/v1`
lifecycle:

```json
{ "decision": "approved" | "rejected" }
```

## Failure

```json
{ "reason": "<non-empty>" }
```

A `failure` Result, a Result that fails validation, and a Result whose
`task` or `role` does not match the Task being processed are all handled the
same way: they do not consume `retry.count`, do not change Task state, and
halt the current loop run for operator recovery, as `aios.task/v1` requires.
