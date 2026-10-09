# Phase 1 Contracts: Server Actions & Route Handlers

**Feature**: `001-retail-pos-inventory` | **Date**: 2026-10-09

This application exposes no public REST API. Its interface surface is **Server Actions** (all mutations)
plus a small number of **Route Handlers** (auth, cron). Each Server Action is a publicly reachable POST
endpoint — the contracts below are therefore security boundaries, not just type signatures.

---

## Universal conventions

### Result type — never throw for expected failures (D5)

```ts
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; message: string; fieldErrors?: Record<string, string[]> };

export type ErrorCode =
  | 'UNAUTHENTICATED'      // no valid session
  | 'FORBIDDEN'            // authenticated, wrong role
  | 'VALIDATION'           // Zod failure; fieldErrors populated
  | 'INSUFFICIENT_STOCK'   // guarded UPDATE matched zero rows
  | 'INSUFFICIENT_CASH'    // would drive cash_on_hand negative
  | 'FUNDING_MISMATCH'     // split ≠ total_cost_minor
  | 'IDEMPOTENCY_CONFLICT' // same key, different payload hash → 422
  | 'IN_FLIGHT'            // duplicate arrived while first still running → retry
  | 'NOT_FOUND'
  | 'CONFLICT'             // state transition invalid (e.g. void an already-voided sale)
  | 'INTERNAL';
```

Thrown errors become opaque digests in production. Only genuine 500s throw. Any `redirect()` inside a
`try/catch` must be re-thrown via `unstable_rethrow`.

### Every mutating action signature

```ts
async function actionName(
  idempotencyKey: string,   // ALWAYS first; client-generated per form render
  input: InputType,
): Promise<ActionResult<OutputType>>
```

`idempotencyKey` is `crypto.randomUUID()` generated when the form is **first rendered** and held stable
across retries. Generating per submit-attempt defeats the mechanism entirely (D9).

### Mandatory preamble — in this order, inside every action

1. `const session = await verifySession()` from the `server-only` DAL → `UNAUTHENTICATED` if absent.
2. Role check → `FORBIDDEN`. Never rely on the proxy or on UI hiding (D6).
3. Zod 4 parse → `VALIDATION` with `z.treeifyError()`. (Zod 4 removed `invalid_type_error` /
   `required_error`; the Next.js docs' own example is stale Zod 3 — D10.)
4. Open the transaction; claim the idempotency key **inside it**; do the work; commit.
5. `updateTag(...)` — **never `revalidateTag`**, which would show the cashier pre-write data (D4).

### Role matrix

| Action group | owner | salesperson |
|---|---|---|
| Catalogue, vendors, grades | ✅ | ❌ |
| Receiving & funding | ✅ | ❌ |
| Sales & returns | ✅ | ✅ |
| Voids | ✅ | ❌ |
| Stock counts, write-offs | ✅ | ❌ |
| Capital & cash | ✅ | ❌ |
| Summary, margin reports | ✅ | ❌ |
| Stock availability (no costs) | ✅ | ✅ |

---

## Catalogue — US1

```ts
createProduct(key, { code, name, unitOfMeasure, reorderLevel })      → { productId }
updateProduct(key, { productId, ...fields })                        → { productId }
deactivateProduct(key, { productId })                               → { productId }
createVendor(key, { name, phone?, email?, notes? })                 → { vendorId }
deactivateVendor(key, { vendorId })                                 → { vendorId }
createQualityGrade(key, { code, label, sortOrder })                 → { gradeId }
```

**Contract**: owner only. `code` unique case-insensitively → `CONFLICT`. Deactivation never deletes;
a delete attempt on a referenced row returns `CONFLICT` with a message naming what references it
(FR-004).

---

## Receiving — US1, US3

```ts
receiveStock(key, {
  productId, vendorId, gradeId,
  qtyReceived,            // > 0
  goodsCostMinor,         // >= 0
  landedCostMinor,        // >= 0, default 0
  receivedAt,             // may be backdated
  reference?,
  funding: { newCapitalMinor, reinvestedMinor },
}) → { batchId, totalCostMinor, effectiveUnitCostMinor }
```

**Transaction (single, atomic)**:
1. Insert `batches` with `qty_remaining = qty_received`.
2. Insert `stock_movements` (`receipt`, `+qty`, `cost = total_cost_minor`).
3. Assert `newCapitalMinor + reinvestedMinor === total_cost_minor` → `FUNDING_MISMATCH` with the
   difference stated (FR-026).
4. Assert `reinvestedMinor <=` retained sale proceeds (data-model §9) → `VALIDATION` (FR-029a).
5. Insert `funding_allocations`.
6. Insert `cash_events` (`out`, `purchase_payment`) — reject if it drives cash negative →
   `INSUFFICIENT_CASH` naming the available balance (FR-031).

```ts
addLandedCost(key, { batchId, additionalCostMinor, funding: {...} })
  → { batchId, totalCostMinor, effectiveUnitCostMinor }
```

```ts
correctBatchCost(key, { batchId, newGoodsCostMinor, reason, funding: {...} })
  → { batchId, totalCostMinor, adjustmentMovementId }
```

**⚠️ Contract trap**: both of these change `total_cost_minor`. In the **same transaction** they must:
1. Re-balance `funding_allocations`, or the FR-026 invariant silently breaks; and
2. Write a zero-quantity `adjustment` movement carrying
   `costOfFirst(T_new, N, consumed) − costOfFirst(T_old, N, consumed)` — the portion of the cost change
   already attributed to units that have been sold (FR-007a).

Skipping (2) leaves Invariant C failing with no visible error until the nightly reconcile fires. Frozen
`sale_lines` costs are never rewritten. Both points are covered by dedicated tests.

```ts
returnToVendor(key, { batchId, quantity, reason }) → { movementId, refundMinor }
```
Guarded decrement; inserts a `vendor_return` movement and a `cash_events` `in`/`vendor_refund` whose
amount is **derived from the batch**, never passed in (FR-023). There is deliberately no refund-amount
parameter: partial credits and restocking fees are out of scope (FR-023a), so a vendor return cannot
move profit.

---

## Selling — US2 (the critical path)

```ts
recordSale(key, {
  paymentMethod,                       // 'cash' | 'card' — label only
  lines: Array<{
    batchId,                           // EXPLICIT — no auto-selection (FR-018)
    quantity,                          // > 0
    unitPriceMinor,                    // may be below cost (FR-017)
  }>,
}) → { saleId, saleNumber, revenueMinor, profitMinor? }   // profit omitted for salesperson
```

**All lines in ONE action.** Server Actions dispatch sequentially per client, so one action per scanned
item would serialize the whole basket (D5).

**Transaction — the order matters**:
1. Claim idempotency key. Duplicate + matching hash → replay stored response. Duplicate + different hash
   → `IDEMPOTENCY_CONFLICT`. In-flight → `IN_FLIGHT`.
2. For each line, the **guarded conditional UPDATE** (D8):
   ```sql
   UPDATE batches SET qty_remaining = qty_remaining - $qty
    WHERE id = $batchId AND qty_remaining >= $qty
   RETURNING qty_received, qty_remaining, total_cost_minor;
   ```
   `rowCount === 0` → `INSUFFICIENT_STOCK`, stating available quantity (FR-015, FR-020). This is a
   **domain error, not a 500**. A `CHECK` violation (SQLSTATE 23514) escaping to the caller is a bug —
   the constraint is a backstop, not the mechanism.
3. Compute `cost_minor` via `batchCostSlice(total, qtyReceived, consumedBefore, consumedAfter)` (D7).
4. Insert `sale_lines`, **freezing** `vendor_id_at_sale`, `grade_id_at_sale`,
   `unit_cost_minor_at_sale` (FR-016).
5. Insert `stock_movements` (`sale`, `−qty`), one per line.
6. Insert `sales` header totals; insert `cash_events` (`in`, `sale`).
7. Commit. Nothing but database work inside the transaction — **no network I/O**, which would hold a
   PgBouncer backend for its duration (D2).

```ts
recordSaleReturn(key, { saleId, lines: [{ saleLineId, quantity }], reason })
  → { returnId, refundMinor }
recordSaleVoid(key, { saleId, reason })   // owner only
  → { saleId, status: 'voided' }
```

Both write **reversing** rows and never delete (FR-021, FR-022, FR-042). Returned units go back to their
original batch at the original frozen cost — not at a recomputed one.

---

## Stock corrections — US1

```ts
recordStockCount(key, { counts: [{ batchId, countedQty }], reason })  → { adjustments[] }
recordWriteOff(key, { batchId, quantity, reason })                   → { movementId }
```
Owner only. `reason` is **required** — enforced by `CHECK` constraint, not just validation (FR-009,
FR-012). Generates adjustment movements rather than editing quantities.

---

## Capital and cash — US3

```ts
recordCapitalInjection(key, { amountMinor, occurredAt, note? })  → { eventId, cashOnHandMinor }
recordWithdrawal(key, { amountMinor, occurredAt, note? })        → { eventId, cashOnHandMinor }
```
Owner only. Withdrawal exceeding cash → `INSUFFICIENT_CASH` naming the available balance (FR-031),
checked inside the transaction against a locked balance — never read-then-write.

---

## Reads (DAL functions, not actions) — US4, US5

```ts
getBusinessSummary({ from?, to? }) → {
  profitToDateMinor,        // gross trading profit — labelled as such (FR-035a)
  capitalInvestedMinor,
  capitalRecoveredMinor,
  cashOnHandMinor,
  inventoryAtCostMinor,
  identityHolds: boolean,   // Invariant B — surfaced, not assumed
}

getStockOnHand({ productId? })    → batches with vendor, grade, qty, unit cost
getMarginReport({ groupBy, from?, to? })  // 'vendor' | 'grade' | 'product'
getSaleDetail({ saleId })         → frozen per-line attribution (FR-038)
getLowStock()                     → products at/below reorder level
```

All owner-only except a cost-free `getStockAvailability()` for the till. Role filtering happens in the
DAL by **not selecting** hidden columns (FR-041b, data-model §14) — not by stripping them afterwards.

**None of these are wrapped in `'use cache'`.** They are uncached reads behind `<Suspense>` (D4).

---

## Route Handlers

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/[...all]` | GET, POST | public | Better Auth handler |
| `/api/cron/reconcile` | GET | `CRON_SECRET` | Nightly Invariants A/B/C; alert on failure |
| `/api/cron/reap-idempotency` | GET | `CRON_SECRET` | Delete expired keys, batched |

Both cron routes are stateless HTTP endpoints invoked by Vercel Cron, per Constitution Principle III
(no in-process timers), and guard themselves with `pg_advisory_xact_lock` so overlapping invocations
don't pile up (D8).

---

## Error presentation

Per FR-044 and the constitution: user-facing messages state what happened and what to do
("Only 2 units left in this batch"). Never leak stack traces, SQL, or secrets. Every `INTERNAL` is
logged server-side with a correlation id that is shown to the user so a report can be traced.

**`Failed to find Server Action`** must be handled as a routine, user-visible retry path — not an edge
case. Action IDs rotate at most every 14 days and a till tab stays open all day (D5).
