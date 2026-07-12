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

Structured Claude runs are recorded in the git-ignored
`.aios/runtime/sessions.json`. This atomic operational ledger keeps one row per
provider session with Task, Role, model, invocation count, token usage, cost,
latest capacity utilization, and reset time when Claude supplies them. Usage
and cost are accumulated across resumed invocations of the same session. The
ledger is not Task lifecycle truth and can be deleted without changing any
Task.

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

The page shows an overview (project, Task counts per state, generation
time) and one card per Task with its id, title, a state badge, retry
count/limit, `approval`, its latest Review id/verdict with the Review's
findings in a collapsible section, and its recorded Attempt count. A Task
in `state: approval` whose decision file `.aios/approvals/<task-id>` does
not yet exist is flagged with the exact path a human must write `approved`
or `rejected` to. Tasks and Reviews are loaded with the same strict
validation the Loop Engine uses; a document that fails to load is rendered
as a visible error card naming the document and reason instead of aborting
the whole dashboard. A separate Worker Sessions section shows the operational
ledger's usage and refill information; a missing ledger is an empty state and
an invalid one is a visible error. The HTML uses inline CSS only and needs no
JavaScript for its core view.

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
`{"failure_reason": "..."}` becomes a `status: failure` Result, and anything
structured but unusable becomes a telemetry-bearing failure Result. Malformed
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
in the environment, one `aios.result/v1` object on stdout. Codex has no
capacity-deferral signal in scope here, so the adapter always emits a bare
Result — never the `aios.worker-execution/v1` transport envelope — which
`CommandWorker` accepts unchanged.

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
with `--sandbox workspace-write` for the Implementer (the one Role meant to
change the repository) and `--sandbox read-only` for the Reviewer and
Approver. The `--dangerously-*` bypass flags are never used.

The reply is read deterministically from a temporary
`--output-last-message` file, which is removed after each session regardless
of outcome. A valid role payload becomes a `status: success` Result, a
`{"failure_reason": "..."}` reply becomes a `status: failure` Result, and
anything unusable — an unparseable or invalid reply, a missing final-message
file, or a nonzero `codex exec` exit — makes the adapter exit nonzero with no
stdout, so the engine halts without a Task transition.

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
