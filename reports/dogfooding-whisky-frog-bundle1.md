# Dogfooding report — first production cross-repo run (whisky-frog-lab bundle-1)

Date: 2026-07-16 (KST). Driver: aios-lab @ `agent/planner-profiles` (WSL).
Target: `C:\Users\djEjg\orca\whisky-frog-lab` (`/mnt/c/...`, NTFS via drvfs).
Objective: review cards R-03, R-10, R-07, R-14 from the target's
`reports/repository-review/IMPLEMENTATION_PLAN.md`, run end to end through
`brief → run → adopt → progress`.

## Outcome

- task-0008 (planning) done; plan `bundle1-correctness-fixes`, profile
  `bug-fix`, 4 proposals. Reviews 0015–0019 all pass.
- task-0009..0012 (R-03, R-07, R-10, R-14) all done. Operator verification:
  fixed 3 defective assertions in the loop-authored `test_auth_cli.py`
  (argon2 salted-hash equality → `verify_password`), then full backend
  suite in a scratch venv: **407 passed, 151 skipped (DB/Redis
  unavailable, repo convention), 0 failed**.
- One real aios-lab engine bug found and fixed during the run (finding 9).

## Findings

### Engine bugs / design gaps

1. **Worker timeout discards finished work.** The first planner session
   wrote the complete plan (later passed `adopt --check` unchanged) but
   exceeded the 300 s default `timeoutMs`; no Attempt was framed, the work
   on disk was invisible to the loop, and routing fell back. Candidates:
   role/protocol-aware default timeouts; on timeout, pre-verify the Task's
   acceptance criteria before discarding.
2. **Provider usage-limit prose is not corroborated into a capacity
   deferral.** Codex's real "You've hit your usage limit … try again at
   Jul 22nd" failed corroboration and surfaced as a hard worker error
   (halt), not exit-75 with `retry_at`; it also consumed the action's one
   fallback. Widen corroboration or classify provider-reported usage
   limits as capacity events.
3. **No persistent candidate cooldown.** After codex exhausted, every new
   action could reselect it; the only lever was editing `enabled: false`
   by hand — which triggers finding 4. Persist (candidate, retry_at) in
   the runtime ledger; add `aios candidate disable|enable <id> [--until]`.
4. **Policy edits brick in-flight actions, fail-closed with no recovery
   tool.** Changing the routing config changes the policy revision;
   `resolveKey` then rejects the recorded rows for any non-terminal
   action ("uses another policy revision"). Recovery required hand-editing
   `runtime/routing-decisions.json` (twice), including manually restoring
   the `updated_at == latest observed_at` invariant. Candidate:
   `aios route reset <task>:<role>:<attempt>` (or supersede terminal-failed
   rows under a new revision with an explicit `policy_changed` reason).
5. **Overrides cannot attach to an already-recorded action** ("recorded
   decisions are immutable … requires a new attempt"). Correct
   fail-closed behavior, but combined with 4 the practical unblock is
   again ledger surgery.
6. **Stale machine-local config fails late.** After the Windows→WSL
   migration both `assignments.json` files pointed at nonexistent
   executables; nothing diagnoses this until dispatch. Candidate:
   `aios doctor` / extend `init --check` to stat candidate commands.
7. **`brief` truncates the derived title mid-word**
   (`…IMPLEMENTATION_P`). Word-boundary truncation or `--title`.
8. **No approval CLI.** Operator approval means hand-writing
   `.aios/approvals/<task-id>`. `aios approve <task-id> [--reject]` would
   also validate task existence/state.
9. **BUG (fixed this session): same-provider override review crashed
   evidence recording.** Pinning the reviewer to the implementer's
   provider while a cross-provider candidate stayed eligible emitted
   `same_provider_review.cross_provider_disqualified` entries with empty
   `reasons`, failing ledger validation and stopping progression.
   Root cause: displaced (eligible) candidates were listed as
   disqualified. Fixed symmetrically in `src/routing-policy.js`
   (construction) and `src/routing-ledger.js` (recomputation); the
   override row already records the displacement. Regression test added
   in `test/routing-policy.test.js`; routing suites 27/27.

### Worker/verification gaps

10. **Verification environments are inconsistent across Workers in the
    same run.** Implementers for tasks 0009–0011 could not run pytest
    (no pip/venv, no Postgres) and shipped "Not run:" verification that
    reviewers accepted; task-0012's implementer built a scratch venv, ran
    the suite, and exposed 3 genuinely broken assertions in
    task-0010's new test file (argon2 salted-hash equality). Candidates:
    a per-target verification-environment contract (documented bootstrap
    the Worker prompt points at), and/or an operator-side verify step
    between review and done.
11. **Pre-existing flaky test in aios-lab:** "CommandWorker waits for a
    timed-out descendant tree to terminate" (`test/workers.test.js:198`)
    fails intermittently under full-suite parallel load
    (ENOENT `descendant.pid`), passes standalone. Fixture timing race.

### Addenda from the capacity-recovery-operations cycle (2026-07-16)

16. **A format-invalid final reply discards a completed attempt.** During
    task-0037 the implementer session finished the work (files + passing
    tests on disk) but prefixed prose to its final JSON reply; the worker
    correctly rejected it ("unusable implementer reply"), yet the effect
    is the same class as finding 1: finished work invisible to the loop,
    session cost lost. The resume path (fresh session sees on-disk work,
    verifies, replies) worked, but candidates worth considering: salvage
    a parseable trailing/embedded JSON object when exactly one exists, or
    have the worker reprompt once for format-only correction within the
    same session. A reviewer-side variant followed on task-0039: a
    substantively valid changes_requested review was rejected as
    "unusable reviewer reply" on a key-shape violation, discarding real
    review findings the next session had to rediscover.

### Operational notes (not engine defects)

12. Capacity stop (`capacity_wait`, exit 5) is opt-out by design without
    `--wait-for-capacity`; the reported `retry_at` had already passed
    when the operator read it. A `progress --resume` honoring recorded
    `retry_at` would smooth the loop.
13. Codex CLI in WSL reports its weekly limit (until 2026-07-22 08:32)
    even directly (`codex exec` outside AIOS); the reset the operator
    observed was a different window/account. Check `codex login status`
    account identity on WSL vs Windows.
14. Piping `aios run` through `tail` masks exit codes; the JSON `kind`
    field preserved the truth. A one-line human summary on stderr would
    help.
15. drvfs (`/mnt/c`) target worked correctly throughout (atomic writes,
    ledger locks, pytest); only cost was latency (~2× slower suite).

## Session artifacts

- whisky-frog-lab: working tree holds the four fixes + tests
  (uncommitted; loop Workers are forbidden to commit), `.aios/` state,
  `plans/bundle1-correctness-fixes/`, ledger backups
  `.aios/runtime/routing-decisions.json.bak*`, and
  `.aios/assignments.windows.json.bak`.
- aios-lab: routing fix + regression test uncommitted on
  `agent/planner-profiles`; machine-local `.aios/assignments.json`
  rewritten to WSL paths (backup `.aios/assignments.windows.json.bak`).
