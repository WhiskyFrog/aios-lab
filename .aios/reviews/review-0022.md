---
schema: aios.review/v1
id: review-0022
project: aios-lab
task: task-0019
attempt: 2
verdict: changes_requested
---

# Review of task-0019, Attempt 2

## Findings

src/progression.js does not reselect the next unfinished Task after an engine outcome of done. It advances directly to the next index, so for an order like [unfinished, already-done, unfinished], the already-done middle Task is passed to engine.run, violating the requirement that completed Tasks are never passed to the engine. After each done outcome, scan only the remaining suffix for the next unfinished Task, preserving the forward cursor so no Task can be invoked twice. Add a regression test that spies on engine.run and verifies an already-done Task after the initial unfinished Task is skipped and included in completed.
