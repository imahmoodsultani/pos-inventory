# Tasks

## 1. Amend the governing documents first

Done before any code contradicts them.

NOTE: the original plan called for amending Constitution Principle II. Reading it showed that is
unnecessary and would be actively misleading — Principle II is scoped to STOCK MOVEMENTS ("Movement
rows MUST NOT be updated or deleted") and the word "capital" appears nowhere in the constitution.
Principle IV, which requires an actor, timestamp and reason on anything moving money, is
strengthened by this change rather than weakened. The only genuine conflict is FR-042's second
clause. No constitutional amendment and no version bump.

- [x] 1.1 Narrow FR-042's second clause in `specs/001-retail-pos-inventory/spec.md` so
      corrections-as-reversing-entries binds sales, purchases and stock movements, while capital
      records are corrected in place with an audit record. Preserve the first clause unchanged —
      nothing becomes deletable. Verify by reading FR-042 and confirming "delete" is still absolute.
- [x] 1.2 Add FRs to `specs/001-retail-pos-inventory/spec.md` for vendor editing, grade editing,
      staff-detail editing, capital correction, and the edit audit log, cross-referencing the
      OpenSpec capabilities. Verify with `grep -c '^- \*\*FR-' spec.md` and update the FR count
      stated in `plan.md` to match.
- [x] 1.3 Update `specs/001-retail-pos-inventory/data-model.md` §6 and §8: move `capital_events` out
      of the fully-immutable tier, describe the source-aware `cash_events` rule, and document the
      new `record_edits` table. Verify the two-tier table in §6 matches the triggers the migration
      will create.

## 2. Audit foundation

Nothing may be made editable before the thing that records edits exists.

- [x] 2.1 Add a `record_edits` table to `lib/db/schema.ts` with `tableName`, `recordId`,
      `fieldName`, `oldValue`, `newValue`, `reason`, `editGroup`, `changedBy`, `changedAt`. Verify
      with `npm run typecheck`.
- [x] 2.2 Generate the migration and hand-add the `forbid_mutation()` trigger on `record_edits` for
      `BEFORE UPDATE OR DELETE`, plus an index on `(table_name, record_id, changed_at DESC)`. Verify
      by applying it locally and confirming an `UPDATE` against `record_edits` raises.
- [x] 2.3 Implement `lib/services/audit.ts` with `recordEdits(tx, actor, { tableName, recordId,
      reason, changes })` writing one row per changed field under a shared `editGroup`, and a
      field-name deny-list (`password`, `token`, `secret`) that records the field changed without
      either value. Verify with `npm run typecheck`.
- [x] 2.4 Write `tests/integration/record-audit.test.ts` covering: a multi-field edit shares one
      `editGroup`; a rejected edit writes nothing; `UPDATE` and `DELETE` on `record_edits` are both
      rejected by the database; a password field is recorded with neither value present. Verify with
      `npm run test:integration`.

## 3. Narrow the immutability tiers

- [x] 3.1 Add a migration replacing the `cash_events` trigger with a source-aware function that
      permits `UPDATE` only when `source_type IN ('capital_injection','withdrawal')` and raises
      otherwise, and dropping `capital_events_append_only`. Verify by applying it locally.
- [x] 3.2 PREMISE WAS WRONG, folded into 3.3. No existing test asserted `capital_events`
      immutability — `audit-trail.test.ts` covers actor attribution only. The tiers were verified by
      hand during the original build and never captured, so there was nothing to narrow and a real
      gap to fill instead.
- [x] 3.3 Added `tests/integration/immutability-tiers.test.ts` asserting every tier: stock movements
      fully immutable; sales and sale lines delete-protected while their columns advance;
      `capital_events` now accepts `UPDATE` but still rejects `DELETE`; a capital-sourced cash row
      accepts `UPDATE` while a sale's takings and a purchase payment reject it; a capital cash row
      cannot be re-pointed at another event; `record_edits` rejects both. Assertions read the driver
      error's cause, because drizzle's wrapper text would match any failure including a SQL typo.
      Verified with `npm run test:integration` — 10 passing.

## 4. Catalogue editing

- [x] 4.1 Implement `updateVendor` and `updateQualityGrade` in `lib/services/catalogue.ts`, writing
      audit rows and rejecting a case-insensitive name collision with `CONFLICT`. Grade `code` and
      product `unitOfMeasure` are not accepted as inputs. Verify with `npm run typecheck`.
- [x] 4.2 Expose both as Server Actions through `defineAction` in `app/(app)/vendors/actions.ts` and
      `app/(app)/grades/actions.ts`, owner-only, invalidating the `catalogue` tag. Verify by
      confirming each uses `defineAction` rather than its own session handling.
- [x] 4.3 Add edit affordances to `app/(app)/inventory/page.tsx` with inline forms reusing the
      existing `CatalogueForm` pattern. Verify by editing a vendor in the running app and seeing the
      new value in the list without a reload.
- [x] 4.4 Extend `tests/integration/us1-referential-guard.test.ts` or add
      `tests/integration/catalogue-editing.test.ts`: renaming a referenced vendor preserves every
      batch's attribution and does not split the margin report; a colliding rename is refused;
      `unitOfMeasure` is unchangeable. Verify with `npm run test:integration`.

## 5. Staff account editing

- [x] 5.1 Implement `updateStaffDetails(tx, actor, { userId, name, email })` in
      `lib/services/users.ts`, rejecting a duplicate email with `CONFLICT`, deleting that user's
      sessions on an email change, and writing audit rows. Verify with `npm run typecheck`.
- [x] 5.2 Expose `updateStaffDetailsAction` and wire the existing `resetUserPasswordAction` into
      `app/(app)/settings/users/actions.ts`. Verify both are owner-only via `defineAction`.
- [x] 5.3 Add edit and reset-password controls to `app/(app)/settings/users/staff-ui.tsx`, showing a
      generated password once with a note that it is not shown again. Verify by resetting a
      password in the running app and signing in with it.
- [x] 5.4 Extend `tests/integration/users.test.ts`: an email change ends that user's sessions; a
      duplicate email is refused; a password reset ends sessions and leaves no password value in
      `record_edits`; the last-active-owner guard still holds for deactivation and demotion. Verify
      with `npm run test:integration`.

## 6. Capital correction

The only part of this change that touches the accounting identity.

- [x] 6.1 Implement `correctCapitalEvent(tx, actor, { eventId, amountMinor, occurredAt, note,
      reason })` in `lib/services/capital.ts`: update the `capital_events` row and its paired
      `cash_events` row in one transaction, reject a `direction` change, require a non-empty reason,
      and write audit rows. Verify with `npm run typecheck`.
- [x] 6.2 Re-validate the cash floor against the post-correction balance using the existing
      `assertCashAvailable` advisory-lock path, covering both directions — reducing a past injection
      can overdraw the till just as raising a withdrawal can. Verify with the test in 6.4.
- [x] 6.3 Expose `correctCapitalEventAction` in `app/(app)/capital/actions.ts` and add an edit
      control with inline audit history to `app/(app)/capital/page.tsx`, so a corrected entry reads
      as corrected rather than as though it was always that value. Verify by correcting an entry in
      the running app and seeing both the new amount and the previous one.
- [x] 6.4 Write `tests/integration/capital-correction.test.ts`: correcting 50,000 to 5,000 moves cash
      and capital invested by exactly 45,000; the identity balances after corrections of arbitrary
      amounts; a correction that would overdraw is refused in both directions; a direction flip is
      refused; an empty reason is refused. Verify with `npm run test:integration`.

## 7. Stock count screen

- [x] 7.1 Build `app/(app)/inventory/count/page.tsx` listing open batches with a counted-quantity
      input per batch and a mandatory reason, calling the existing `recordStockCountAction`. Verify
      by recording a count in the running app and seeing adjustment movements on the batch history.
- [x] 7.2 Add a Playwright case to `tests/e2e/` covering a physical count that records a shortfall,
      asserting the stock figure updates in the same response. Verify with `npm run test:e2e`.

## 8. Integration verification

- [x] 8.1 Run the full suite — `npm run typecheck`, `npm run lint`, `npm run test:unit`,
      `npm run test:integration`, `npm run test:e2e`, `npm run build` — and confirm every check
      passes with no narrowed assertion left failing.
- [x] 8.2 Exercise the complete correction path against the local database: create a vendor, receive
      stock, record a sale, inject capital, then correct the vendor name, the staff email and the
      capital amount, and confirm the reconciliation screen still reports all three invariants
      holding.
- [x] 8.3 Update `README.md` to describe which records are editable, which remain append-only, and
      why — the same tiering the triggers enforce. Verify the README table matches the migration.
