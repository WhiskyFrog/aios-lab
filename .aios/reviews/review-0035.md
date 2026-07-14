---
schema: aios.review/v1
id: review-0035
project: aios-lab
task: task-0024
attempt: 1
verdict: changes_requested
---

# Review of task-0024, Attempt 1

## Findings

1. src/routing.js parent-plan discovery does not fully validate adopted plans. It validates metadata and readPlanOrder only, so a PLAN.md missing required Brief, Profile Application, Assumptions and Risks, or Decomposition Rationale sections can still be accepted as the parent and permit a lower tier. Reuse or extend the existing plan validation path so every malformed adopted plan fails closed, with a regression test for structurally malformed but parseable PLAN.md content.
2. planningContract is not strict enough: plan-path, adopt, and --check matches may come from unrelated text or separate commands, and its write-limitation regex can match negative or otherwise non-exclusive constraints. Require an actual non-mutating adopt <plan> --check verification and an unambiguous plan-directory-only write constraint; add false-positive tests.
3. Review/session history is consumed as unvalidated ad-hoc objects. Unknown or malformed outcomes are treated as benign and can allow a lower tier, while the tests use records that are not valid Review or session documents. Reuse existing Review/session validation or fail closed on malformed supplied history.
4. The normalized context lacks source labels for generated non-default evidence including uncertainty_flags, lower_tier/rejection reasons, and diagnostics, contrary to the source-label requirement. Add inspectable source attribution for these values.
5. The deterministic thresholds, evidence precedence, uncertainty treatment, and exact lower-tier gate are not documented outside the implementation. Add documentation as required.
6. Tests do not cover every validation rule. Missing cases include candidate enabled/context_limit/Role validation, duplicate class/catalog values and provider targets, high-tier/default-budget references, hint selector/enums/budget references, override unknown-candidate/boolean validation, and unknown fields across all nested groups. Expand coverage accordingly.
