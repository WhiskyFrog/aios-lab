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

`aios run` exits with 0 when the Task reaches `done`, 2 when it reaches
`blocked`, 1 when the run halts for operator recovery, and 64 for a usage
error.

Assignment commands are trusted local configuration and run with the current
user's permissions. Do not execute an Assignment file from an untrusted
repository.

## Command Worker

Commands are launched directly from their argv array with no shell
interpolation. The repository root is their working directory. A Worker:

1. Receives the complete Task Markdown document as UTF-8 stdin.
2. Reads `AIOS_TASK_ID` and `AIOS_ROLE` from the environment when useful.
3. Writes exactly one `aios.result/v1` JSON object to stdout.
4. Writes diagnostic logs only to stderr.

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
`AIOS_ROLE`/`AIOS_TASK_ID` in the environment, one `aios.result/v1` object
on stdout. The session's JSON-only reply becomes the Result payload; a
reply of `{"failure_reason": "..."}` becomes a `status: failure` Result,
and anything unusable exits nonzero so the engine halts without a Task
transition.

```json
{
  "schema": "aios.assignments/v1",
  "assignments": {
    "implementer": ["node", "workers/claude-worker.mjs", "C:\\path\\to\\claude.exe"],
    "reviewer": ["node", "workers/claude-worker.mjs", "C:\\path\\to\\claude.exe"]
  }
}
```

The trailing argument (or `AIOS_CLAUDE_CLI`) names the Claude executable —
required on Windows when `claude` resolves to a `.ps1`/`.cmd` shim, because
Workers are spawned without a shell. `AIOS_CLAUDE_MODEL` overrides the
model alias (default `sonnet`).

Permission model: the Implementer session runs with `acceptEdits` and Bash
allowed — it is the one Role meant to change the repository. Reviewer and
Approver sessions keep the default non-interactive permissions, where only
read-only tools plus `npm test` work. Prompts additionally forbid every
session from touching `.aios/` or git history; the engine's conflict
detection halts the run if a Worker modifies the active Task anyway.

Caveats: each Role action starts a fresh session that bills usage, and an
Implementer session executes with your local permissions — assign it only
to repositories you trust it to edit, and raise `--timeout-ms` (Sprint 0
default 300000) for real implementation work.

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
scheduling and concurrency remain future requirements.
