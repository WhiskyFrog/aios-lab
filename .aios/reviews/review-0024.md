---
schema: aios.review/v1
id: review-0024
project: aios-lab
task: task-0020
attempt: 1
verdict: changes_requested
---

# Review of task-0020, Attempt 1

## Findings

Cancellation is not checked between Tasks: runProgression immediately calls engine.run for the next Task even when the shared signal became aborted after the previous Task completed. LoopEngine/CommandWorker then spawns that next Task's Worker before observing the already-aborted signal, violating the requirement to stop without starting a new Task. Add a core progression-level abort check before every engine invocation and CLI coverage for cancellation at a Task boundary. Also, the required regression coverage is incomplete: test/cli.test.js only checks dashboard/adopt parsing failures; it does not invoke those CLI subcommands and pin their successful output/exit codes, adopt's validation-failure exit 1, or run's halted/blocked exits 1 and 2. Add CLI-entry-point regression tests for those existing behaviors.
