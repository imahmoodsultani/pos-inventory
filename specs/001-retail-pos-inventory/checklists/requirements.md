# Specification Quality Checklist: Retail POS with Batch-Level Inventory, Cost Attribution, and Capital Tracking

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**Validation iteration 1 (2026-10-09)** — one item failing: three `[NEEDS CLARIFICATION]` markers
(FR-013 unit identity, FR-018 batch selection, FR-029 reinvestment traceability).

**Validation iteration 2 (2026-10-09, after `/speckit.clarify`)** — all items pass.

Five clarifications were resolved and recorded in the spec's `## Clarifications` section:

1. **Unit identity** → batch-level quantities only; no per-unit serial or tag (FR-013).
2. **Batch selection at sale** → always chosen explicitly by the seller; no auto-pick (FR-018, FR-018a,
   FR-018b).
3. **Reinvestment traceability** → pooled cash balance; no link to a named source sale (FR-029,
   FR-029a).
4. **Profit basis** → gross trading profit only; no expense tracking (FR-035, FR-035a, FR-035b).
5. **Users and roles** → owner plus salesperson, with cost/profit/capital hidden from salespeople
   (FR-041, FR-041a, FR-041b).

Terminology was normalized to "batch" throughout (the title and User Story 1 previously said "lot").

Accepted limitations carried into planning — both are deliberate, not oversights:

- **Expenses are untracked.** If the owner pays rent or wages out of the till, system cash on hand will
  exceed physical cash unless the payment is logged as a withdrawal — which then counts toward capital
  recovered rather than expenses. Documented under Assumptions with this consequence spelled out.
- **Explicit batch selection costs time at the till.** SC-006 (two-line sale in under 60 seconds)
  becomes the binding constraint on the batch picker's design, since salespeople choose by vendor,
  grade, quantity, and date without seeing cost (FR-018a + FR-041).

Notes for the planning phase:

- "Vercel deployment" is deliberately absent from the spec — it is a technology decision already
  governed by the project constitution (Principle III, Technology & Deployment Constraints) and belongs
  in `plan.md`.
- FR-019 (atomic sale), FR-020 (concurrent last-unit), and SC-003 (the reconciliation identity) are the
  highest-risk requirements to implement correctly and map directly onto Constitution Principle I,
  which is non-negotiable. Plan test coverage for them first.
