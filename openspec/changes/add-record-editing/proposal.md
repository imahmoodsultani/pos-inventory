# Proposal

## Why

Several records in the system cannot be corrected at all once saved. A capital injection typed as
50,000 instead of 5,000 has no fix path — `capital_events` is append-only by database trigger and
no correcting action exists. Vendor and quality-grade details cannot be edited after creation; the
only option is to deactivate and recreate, which splits that vendor's margin history in two. A
staff member's email address can never be changed, and the password-reset service exists but is
unreachable from the UI.

These are ordinary mistakes an owner will make in the first week of use. The system was designed so
that transactional history is immutable and corrections are reversing entries, which is right for
sales and stock. It was never extended to the owner's own reference data and capital record, where
the immutability buys little and costs the ability to fix a typo.

## What Changes

- **BREAKING — `capital_events` and its paired `cash_events` row become editable in place.** The
  `capital_events_append_only` trigger is removed and the `cash_events` trigger is narrowed so a
  capital-sourced cash row can be amended alongside its capital event. Both rows are updated in one
  transaction so the SC-003 accounting identity continues to balance.
- **BREAKING — narrows the second clause of FR-042.** FR-042 currently says corrections "MUST be
  recorded as new reversing or adjusting entries". That binds sales, purchases and stock movements;
  capital records are excepted and corrected in place with an audit record. Its first clause — that
  nothing is ever permanently deleted — is unchanged.

  **No constitutional amendment is required.** Principle II is scoped to stock movements ("Movement
  rows MUST NOT be updated or deleted") and never covered capital events; the word "capital" does
  not appear in the constitution. Principle IV, which requires an actor, timestamp and reason on
  anything that moves money, is strengthened by the audit log rather than weakened. An earlier draft
  of this proposal claimed Principle II had to be amended; that was wrong.
- Introduces an **edit audit log**: every in-place edit to a transactional record stores who changed
  it, when, which field, and the before and after values. Immutability is replaced by
  accountability rather than removed outright.
- Vendors become editable — name, phone, email, notes.
- Quality grades become editable — label and sort order.
- A staff member's email address and display name become editable by an owner.
- The existing password-reset service gains an owner-facing screen.
- The existing stock-count service gains a screen, so a physical count can be recorded without a
  developer running a script.

Explicitly **not** changing in this change:

- Sales, sale lines, and stock movements remain append-only. Correcting a sale remains
  void-and-rerecord; correcting a batch cost remains `correctBatchCost`. The frozen vendor, grade,
  and unit cost on a sale line are what make historical profit answerable and stay immutable.
- `products.unit_of_measure` stays immutable. Changing it after units exist would silently
  reinterpret every quantity already recorded against that product.
- Margin is not editable because it is not stored — it is computed from price and cost at read
  time. Editing it means editing one of those inputs.

## Capabilities

### New Capabilities

- `catalogue-management`: maintaining the products, vendors, and quality grades that batches are
  recorded against, including correcting their details after creation and deactivating entries that
  must not be used for new stock.
- `staff-accounts`: creating and maintaining the people who can use the system — identity details,
  credentials, role, and active status — including the constraint that the business can never be
  left without an active owner.
- `capital-ledger`: recording the owner's injections and withdrawals, correcting them when entered
  wrongly, and keeping cash on hand and the capital totals consistent with every correction.
- `record-audit`: recording who changed a stored record, when, and from what value to what value, so
  that relaxing immutability does not cost the ability to explain a figure.

### Modified Capabilities

<!-- None. This change creates the project's first OpenSpec capability specs; the existing
     specification lives in specs/001-retail-pos-inventory/ under the spec-kit workflow. -->

## Impact

**Database**

- Drops `capital_events_append_only`; narrows the `cash_events` append-only trigger so rows with
  `source_type IN ('capital_injection','withdrawal')` may be updated while sale, refund, purchase
  and vendor-refund cash rows stay immutable.
- Adds a `record_edits` table for the audit log.
- Adds `UPDATE` paths for `vendors` and `quality_grades`, which are already physically mutable.

**Specification documents**

- `.specify/memory/constitution.md` — **unchanged.** See the note under What Changes.
- `specs/001-retail-pos-inventory/spec.md` — FR-042's second clause is narrowed; new requirements
  are added for vendor, grade, staff and capital editing, and for the audit log.
- `specs/001-retail-pos-inventory/data-model.md` — §6 and §8 trigger tiers, plus the new table.

**Code**

- `lib/services/catalogue.ts` — add `updateVendor`, `updateQualityGrade`.
- `lib/services/capital.ts` — add `correctCapitalEvent`.
- `lib/services/users.ts` — add `updateStaffDetails`.
- `lib/services/audit.ts` — new.
- `app/(app)/inventory/`, `app/(app)/settings/users/`, `app/(app)/capital/` — edit affordances.
- New screen for stock counts.

**Tests**

- The append-only assertions in `tests/integration/audit-trail.test.ts` and the trigger probes must
  be narrowed to match the new tiers; they currently assert that `capital_events` rejects every
  `UPDATE`.
- Invariant B must be re-asserted after a capital correction — that is the test that proves the
  identity survives editing.
