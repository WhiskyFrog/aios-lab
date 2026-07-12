# Contributing

This repository is driven by Task documents, not by ad hoc changes. If you
are new here, read this file before touching anything under `.aios/`.

## Tasks are the durable worklist

A Task document is the single source of truth for one unit of work. Its
YAML front matter is the machine-owned control plane (state, retry count,
approval status, last review); its Markdown body is the human-readable
brief and the append-only history of Attempts. The Loop Engine — not a
human, and not a Worker — is the only writer of front matter, Attempts,
and Review references.

The full contract, including the state machine, invariants, and Attempt
framing, lives in [`.aios/tasks/README.md`](.aios/tasks/README.md). Read
it before defining or hand-editing a Task.

## Defining a new Task

1. Copy [`.aios/tasks/TASK_TEMPLATE.md`](.aios/tasks/TASK_TEMPLATE.md) to
   `.aios/tasks/<id>.md`.
2. Choose the next `id` matching `^task-[0-9]{4,}$` (for example
   `task-0008` after `task-0007`); the filename must be that ID plus
   `.md`.
3. Fill in `project`, `title`, `Objective`, and at least one observable
   `Acceptance Criteria` item. Set `Constraints` and `Context` when they
   carry real information.
4. Leave the machine-owned front matter at its initial values:
   `state: implement`, `retry: { count: 0, limit: <your choice> }`,
   `approval: not_required` or `required`, `last_review: null`. Only the
   Loop Engine changes these fields afterward.
5. Leave `## Attempts` as `_None yet._` — the engine appends the first
   Attempt once an Implementer Result succeeds.

## Starting the loop

Install the one dependency, then run one Task through the engine:

```console
npm install
npm run aios -- run <task-id> --assignments .aios/assignments.json
```

`aios run` reads the Task's `state`, resolves the Role that state
requires through the Assignment file, invokes that Role's Worker, and
continues until the Task reaches `done`, `blocked`, or the run halts for
operator recovery. See [`README.md`](README.md) for exit codes, the
Assignment file shape, and the Command Worker and Claude Code Worker
contracts.

## The three Roles and how Assignments bind them

Every Task state maps to exactly one permanent Role — `implementer`,
`reviewer`, or `approver` — never to an agent, model, or human identity
directly. An Assignment file (for example
`.aios/assignments.json`, kept outside `.aios/tasks/`) maps each Role
name to the command that currently plays it, and the engine re-reads that
file before every Role action. Swapping a Worker means editing the
Assignment file, not the Task.

`README.md` documents two Worker kinds you can assign: a plain Command
Worker (any executable following the stdin/stdout Result contract) and
`workers/claude-worker.mjs`, which binds a Role to a non-interactive
Claude Code session.

## The approval gate

A Task with `approval: required` inserts a fourth state, `approval`,
between a passing `review` and `done`. The `approver` Role decides
`approved` or `rejected` there; a Task with `approval: not_required`
skips straight from a passing review to `done`.

When the `approver` Role is assigned to `workers/human-approver.mjs`,
that decision is a human's, made through a file, not a session. The
worker reads `.aios/approvals/<task-id>` and never writes it. Before that
file exists, the run halts with a failure naming the exact path to create
and the only two accepted contents, `approved` or `rejected`. Full
details, including the halt-then-resume flow, are in the
[Human Approver Worker section of `README.md`](README.md#human-approver-worker).

## The operator's role

The operator is the human running `aios run` and is responsible for work
the engine deliberately does not do:

- **Defining Tasks** — writing the Objective, Acceptance Criteria,
  Constraints, and Context a Worker needs, as described above.
- **Committing after loop steps** — the engine mutates Task files (and,
  for reviews, creates immutable files under `.aios/reviews/`) but never
  runs git. After a run advances or halts a Task, review the diff and
  commit it yourself so the repository's history matches the Task's
  actual state.
- **Resuming halted runs** — a nonzero Worker exit, timeout, malformed
  Result, missing Assignment, or an approval decision file not yet
  written all halt the run without a state transition. Inspect the
  cause, fix it (for example, write the approval decision file), and
  rerun `aios run <task-id> --assignments ...` to continue.

For the Result envelope that Workers return to the engine, see
[`.aios/results/README.md`](.aios/results/README.md). For the immutable
Review documents a `reviewer` Result produces, see
[`.aios/reviews/README.md`](.aios/reviews/README.md).
