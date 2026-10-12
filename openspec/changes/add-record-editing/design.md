# Design

## Context

See proposal.md — Why.

Three facts shape the approach:

**Immutability is enforced by the database, not by convention.** A single `forbid_mutation()`
function raises on any attempt, attached as `BEFORE UPDATE OR DELETE` to `stock_movements`,
`capital_events` and `cash_events`, and as `BEFORE DELETE` to `sales`, `sale_lines`, `batches` and
`funding_allocations`. Nothing in application code can bypass it, which is why relaxing it is a
migration rather than a refactor.

**A capital event and its cash event are one business fact in two rows.** Recording an injection
writes `capital_events` plus a `cash_events` row with `source_type` `capital_injection` and
`source_id` pointing at the capital event, coupled by a unique index on
`(source_type, source_id)`. Capital invested is summed from the first table; cash on hand from the
second. Correcting one without the other breaks the SC-003 identity immediately.

**The identity is asserted everywhere.** It runs after every integration test, nightly in cron, and
is surfaced on the summary screen with a visible warning when it fails. Any design here that can
make it drift will be caught — which is useful, but the design should not rely on being caught.

## Goals / Non-Goals

**Goals:**

- Relax immutability by the smallest possible amount: one table, plus one narrowly-scoped class of
  rows in a second table.
- Replace what immutability was providing (the ability to explain a figure) with something that
  provides it explicitly, rather than losing it.
- Keep the existing trigger mechanism as the enforcement point, so "what can be edited" stays
  answerable by reading the migration rather than by auditing application code.

**Non-Goals:**

- A general-purpose edit framework. Four capabilities need editing; a generic one would invite the
  fifth to be added without thinking about whether it should be.
- Soft deletes or record versioning. The audit log records *what changed*, not a restorable
  snapshot of every past state.
- Undo. Correcting a correction is another correction.

## Decisions

### Narrow the trigger rather than drop it

`capital_events` loses its trigger entirely — every column on it becomes editable, and the spec
restricts direction changes at the service layer rather than the database, because `event_type` is
legitimately written once at insert.

`cash_events` keeps its trigger but the function becomes source-aware: an `UPDATE` is permitted only
when the row's `source_type` is `capital_injection` or `withdrawal`. Everything else — sale takings,
customer refunds, purchase payments, vendor refunds, cost adjustments — still raises.

*Alternative considered:* drop the `cash_events` trigger and enforce the restriction in the service
layer. Rejected because the trigger is currently the only thing standing between a future code path
and a rewritten sale, and the value of a database-enforced rule is precisely that it holds for code
nobody has written yet.

*Alternative considered:* leave both triggers and model a capital correction as a reversing entry
pair. Rejected — the user asked for in-place editing and this is the one place in the scope where
that choice actually applies. It also leaves the capital screen showing three entries where one
mistake was made.

### One audit row per field changed

`record_edits` stores `(table_name, record_id, field_name, old_value, new_value, reason, changed_by,
changed_at, edit_group)`. Values are stored as text; these are low-volume records read by a human.

`edit_group` is a UUID shared by every row written in one edit, so "the owner changed the name and
the email in one action" is reconstructable rather than appearing as two unrelated events.

*Alternative considered:* one row per edit with a JSON diff. Rejected because querying "every change
ever made to vendor 12's email" becomes a JSON path expression rather than a `WHERE`, and the audit
log's whole purpose is being readable under pressure.

### The audit log is itself append-only

`record_edits` gets the existing `forbid_mutation()` trigger for both `UPDATE` and `DELETE`. An audit
trail that can be rewritten answers nothing, and this is the one table where immutability has no
usability cost — nobody needs to correct a record of a correction.

### Secret fields are named, not inferred

A fixed deny-list of field names (`password`, `token`, `secret`) is checked when writing audit rows;
a match records the field name and that it changed, with both values omitted. A deny-list rather
than an allow-list because new non-secret fields appear constantly and new secret fields rarely, so
the failure mode of forgetting to update the list is "a new field is audited" rather than "a new
secret leaks".

### Capital corrections re-validate the cash floor

A correction recomputes cash on hand as it would be *after* the change and refuses if it is
negative, reusing the existing `assertCashAvailable` advisory-lock path. This covers the
non-obvious direction: reducing a past *injection* can overdraw the till just as raising a
withdrawal can, because money that arrived may already have been spent.

### The constitution is left alone, deliberately

Principle II reads as an absolute, and it stays that way — it is scoped to stock movements, which
this change does not touch. Amending it to carve out capital events would weaken a principle that
never covered them, and leave a version-bumped amendment implying the ledger guarantee had been
traded away. It has not been.

Only FR-042's second clause changes. Principle IV already requires an actor, timestamp and reason on
anything moving money; the audit log satisfies it more completely than immutability did, since
immutability recorded the original but said nothing about who later wanted it different.

## Risks / Trade-offs

**A corrected capital event silently changes a figure the owner already acted on** → The audit
history is shown inline on the capital screen, not on a separate page, so a corrected entry is
visibly corrected rather than looking like it was always that value.

**Narrowing the `cash_events` trigger weakens a load-bearing guarantee** → The trigger condition is
asserted directly in the integration suite: a test attempts to update a sale's cash row and asserts
the database rejects it. That test is the guarantee, not the trigger definition.

**The identity can drift if the two rows are updated outside one transaction** → Both updates happen
in a single service function that takes the transaction handle, and the test suite asserts the
identity immediately after a correction with arbitrary amounts.

**The existing test suite asserts the old behaviour** → `tests/integration/audit-trail.test.ts`
currently asserts `capital_events` rejects every `UPDATE`. That assertion must be narrowed in the
same change, not left failing or deleted. A deleted assertion is indistinguishable from a
requirement that was quietly dropped.

**Scope creep toward "edit everything"** → The trigger tiers are the enforcement. Making sales or
stock movements editable later would require another migration AND an amendment to Principle II,
which this change deliberately leaves intact. That is the intended friction.

## Migration Plan

1. Additive first: create `record_edits` and its append-only trigger. Nothing depends on it yet.
2. Replace the `cash_events` trigger with the source-aware version. Still no behaviour change —
   nothing yet issues an `UPDATE` against a capital-sourced cash row.
3. Drop `capital_events_append_only`.
4. Ship the services and screens.

Steps 1–3 are expand-only and tolerated by the currently deployed release, so the migration can run
before promote, as the deploy workflow requires.

**Rollback:** re-adding the dropped trigger is a one-line migration. Any capital event edited in the
interim keeps its corrected value — the correction is not undone by restoring immutability, which is
the correct outcome, since the corrected figure is the true one.

## Open Questions

- Whether the audit history belongs on each record's own screen only, or also as a single
  business-wide activity feed. The feed is additive and does not change the data model, so it can be
  decided after the per-record view is in use.
