---
schema: aios.plan/v1
id: aios-dashboard-app
project: aios-lab
profile: website
profile_reason: The goal is a single responsive, accessible web surface with
  distinct informational sections (introduction, workflow, current work,
  upcoming work, next actions) for a human audience, not new backend
  behavior or a data/platform transition, so the narrowest fitting profile
  is website rather than the generic-goal or software-feature fallback.
---

# Plan the AIOS product dashboard

## Brief

Turn "build a web dashboard that introduces AIOS and shows current and
upcoming work" into a reviewed set of focused Task proposals. The product
must cover an AIOS introduction and workflow explanation, current Task
lifecycle data, adopted upcoming Tasks, not-yet-adopted plan proposals,
clear next actions, and responsive/accessibility quality, while preserving
the existing self-contained, offline `aios dashboard` foundation
(`src/dashboard.js`, `test/dashboard.test.js`, the README Dashboard
section) unless a concrete reason requires a server or a separate
application.

## Profile Application

The `website` profile's decomposition emphasis — information architecture,
shared visual system, pages, and accessibility — maps directly onto this
brief even though the product is delivered as one generated HTML document
rather than several linked documents: each required piece of content
(introduction, workflow, lifecycle data, upcoming Tasks, plan proposals,
next actions) is treated as one information-architecture section within a
shared visual system, and the profile's verification emphasis (content,
responsive layouts, accessibility, navigation) is why the plan requires an
explicit responsive/accessibility acceptance criterion rather than treating
layout as an afterthought. `software-feature` was considered and rejected
as broader than necessary: the interesting risk here is content structure
and presentation quality for a human reader, not contracts or backend
integration, so `website` is the narrower, better-fitting choice.

## Assumptions and Risks

- The current one-shot, self-contained `aios dashboard` command
  (`src/dashboard.js`) is architecturally sufficient: the product goal is
  an informational snapshot for a human operator, not multi-user access,
  authentication, or live updates, so no server, daemon, watcher, or live
  polling is required. This plan extends that command's data collection
  and rendering rather than introducing a separate application.
- "Not-yet-adopted plan proposals" are read from `PLAN.md` files under
  `plans/`; the risk is that adoption state is not directly recorded
  anywhere and must be inferred from whether placeholder `P-##` references
  in a plan's `PLAN.md` have already been rewritten to real Task ids by
  `adopt` (see `src/plans.js`). If a plan is only partially adopted the
  first proposal below must still report something reasonable rather than
  erroring.
- "Adopted upcoming Tasks" reuses the existing Task lifecycle data
  `src/dashboard.js` already collects; the risk is scope creep into
  redesigning that existing view instead of only adding the missing
  surfaces (introduction, workflow explanation, plan proposals, next
  actions) around it.
- Accessibility and responsiveness are assumed achievable with semantic
  HTML and CSS alone, consistent with the existing dashboard's inline-CSS,
  no-required-JavaScript approach; no new runtime dependency is assumed to
  be necessary.

## Decomposition Rationale

The work splits into one data-source proposal and one UI proposal because
the new data this product needs (not-yet-adopted plan proposals and a
next-actions summary derived from Task and plan state) is independently
definable and testable as plain functions with no rendering concerns, while
assembling and presenting that data alongside the existing Task lifecycle
view, the AIOS introduction, and the workflow explanation is a distinct,
presentation-focused unit of work. Putting the data-source proposal first
lets its Worker session finish and be independently verified (through
automated tests on plain data structures) before the UI proposal consumes
it, so each proposal stays reviewable and fits one focused session. Neither
proposal needs a dependency field: their relationship is expressed only by
this execution order.

## Execution Order

1. task-0015 adds the read-only data source for not-yet-adopted plan proposals
   and a next-actions summary, the shared foundation the UI proposal below
   consumes.
2. task-0016 builds the AIOS product dashboard page itself: introduction,
   workflow explanation, current Task lifecycle data, adopted upcoming
   Tasks, not-yet-adopted plan proposals, next actions, and
   responsive/accessible layout, extending the existing self-contained
   dashboard generator.
