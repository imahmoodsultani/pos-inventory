# Phase 1 Data Model: Retail POS with Batch-Level Inventory

**Feature**: `001-retail-pos-inventory` | **Date**: 2026-10-09
**Depends on**: [research.md](./research.md) | **Implements**: [spec.md](./spec.md)

Postgres 17. All monetary values are `BIGINT` **minor units** (D7). All timestamps are `TIMESTAMPTZ`
generated server-side. No transactional row is ever hard-deleted (FR-042).

---

## Entity overview

```
users ──< sessions
  │
  └──< (actor on every mutating row)

vendors ──┐
products ─┼──< batches ──< stock_movements
grades ───┘       │              │
                  │              └──> (ref_type, ref_id) → sale_lines | adjustments
                  └──< funding_allocations ──> capital_events

sales ──< sale_lines ──> batches   (frozen cost/vendor/grade snapshot)

cash_events (append-only)  ← derived: cash_on_hand
idempotency_keys           ← guards every mutating action
```

---

## 1. `users`

Managed by Better Auth's Drizzle adapter; `role` added via `additionalFields` (D6).

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | Better Auth generated |
| `email` | `TEXT` NOT NULL UNIQUE | login identifier |
| `name` | `TEXT` NOT NULL | |
| `role` | `TEXT` NOT NULL | `CHECK (role IN ('owner','salesperson'))` — FR-041 |
| `is_active` | `BOOLEAN` NOT NULL DEFAULT true | FR-041a; deactivate, never delete |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | |

**Rules**: role is assigned server-side only, never from client input. At least one active `owner` must
always exist — deactivating the last owner is rejected.

`sessions`, `accounts`, `verifications` follow the Better Auth schema unchanged. Sessions live in
Postgres so revocation is immediate (D6).

---

## 2. `vendors` — FR-002

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` GENERATED ALWAYS AS IDENTITY PK | |
| `name` | `TEXT` NOT NULL | `UNIQUE (lower(name))` |
| `phone`, `email`, `notes` | `TEXT` NULL | |
| `is_active` | `BOOLEAN` NOT NULL DEFAULT true | |
| `created_at`, `created_by` | `TIMESTAMPTZ`, `TEXT` → users | |

**Rules**: FR-004 — deletion rejected when referenced by any batch; deactivate instead. Inactive vendors
are hidden from new receipts but remain in all history and reports.

---

## 3. `quality_grades` — FR-003

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `code` | `TEXT` NOT NULL UNIQUE | e.g. `A`, `B`, `C` |
| `label` | `TEXT` NOT NULL | |
| `sort_order` | `INTEGER` NOT NULL | display ordering at the till |
| `is_active` | `BOOLEAN` NOT NULL DEFAULT true | |

**Rules**: mandatory on every batch. Deletion rejected when referenced (FR-004).

---

## 4. `products` — FR-001

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `code` | `TEXT` NOT NULL UNIQUE | SKU; scanner-enterable |
| `name` | `TEXT` NOT NULL | |
| `unit_of_measure` | `TEXT` NOT NULL | **discrete countable units only** — `piece`, `box`, `pack`, `pair`. `CHECK (unit_of_measure IN (...))`. Weight and length units are forbidden (FR-001): all quantities are `INTEGER`, so a fractional unit could be stored but never transacted. |
| `reorder_level` | `INTEGER` NOT NULL DEFAULT 0 | FR-039 |
| `is_active` | `BOOLEAN` NOT NULL DEFAULT true | |
| `created_at`, `created_by` | | |

**Rules**: FR-004 — no deletion when batches or sale lines reference it. Quantities are whole units;
FR-013 fixed no per-unit identity, so there is deliberately **no `units` or `serials` table**.

---

## 5. `batches` — the anchor of all cost attribution (FR-005 … FR-008)

One receipt of one product, from one vendor, at one quality, at one rate.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `product_id` | `BIGINT` NOT NULL → products | |
| `vendor_id` | `BIGINT` NOT NULL → vendors | |
| `grade_id` | `BIGINT` NOT NULL → quality_grades | |
| `received_at` | `TIMESTAMPTZ` NOT NULL | backdating allowed (edge case) |
| `reference` | `TEXT` NULL | vendor invoice no. |
| `qty_received` | `INTEGER` NOT NULL | `CHECK (qty_received > 0)` |
| `qty_remaining` | `INTEGER` NOT NULL | denormalized cache — see below |
| `goods_cost_minor` | `BIGINT` NOT NULL | `CHECK (>= 0)` |
| `landed_cost_minor` | `BIGINT` NOT NULL DEFAULT 0 | freight/duty/handling — FR-007 |
| `total_cost_minor` | `BIGINT` GENERATED ALWAYS AS (`goods_cost_minor + landed_cost_minor`) STORED | |
| `is_cost_corrected` | `BOOLEAN` NOT NULL DEFAULT false | FR-038 / US5 scenario 3 |
| `created_at`, `created_by` | | |

**Constraints**
```sql
CONSTRAINT qty_remaining_sane CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received)
```
`qty_remaining >= 0` is the **backstop**, not the oversell mechanism (D8).

**Indexes**: `(product_id, qty_remaining)` for the till's batch picker; `(vendor_id)`, `(grade_id)` for
the margin report; `(product_id, received_at, id)` for display ordering.

### Why `qty_remaining` is permitted

Constitution Principle II allows a denormalized quantity **only** as a reconstructible optimization. It
is maintained exclusively by the guarded conditional UPDATE inside the sale transaction (D8), never by a
trigger, so the concurrency mechanism stays visible in application code. Reconstructibility is proven by
the reconciliation query in §12.

### Per-unit cost is derived, never stored

FR-007 requires per-unit costs that sum back exactly to the total. Storing a rounded unit cost is how
that invariant breaks. Instead (D7), with `T = total_cost_minor`, `N = qty_received`, and
`consumed = qty_received - qty_remaining`:

```
costOfFirst(k)    = floor(T * k / N)
costOfUnits(a, b) = costOfFirst(b) - costOfFirst(a)
```

Drawing units `(consumed_before, consumed_after]` telescopes to exactly `T` when the batch is fully
depleted, for any draw order or chunking.

### Changing `T` after units have already been sold — FR-007a

Adding a landed cost or correcting a wrong rate changes `total_cost_minor`. Units already sold carry a
`cost_minor` computed from the **old** `T`, so the telescoping property breaks and Invariant C fails
unless the difference is explicitly booked.

**Rule**: in the same transaction as the cost change, write one `adjustment` movement with
`qty_delta = 0`-equivalent semantics — see below — carrying the entire difference:

```
delta = costOfFirst(T_new, N, consumed) − costOfFirst(T_old, N, consumed)
```

where `consumed = qty_received − qty_remaining` at the moment of correction. That is exactly the amount
of the cost change already attributed to sold units. Invariant C then becomes:

```
Σ stock_movements.cost_minor WHERE movement_type <> 'receipt'
    = batches.total_cost_minor            (adjustments included)
```

The `receipt` row is excluded: it carries the batch's full cost as the **inbound** side of the
ledger, so summing it with the outbound rows gives `2 × total` for every depleted batch. Only the
outbound movements — sales, write-offs, vendor returns, and FR-007a adjustments — are allocations
*out of* the total.

`stock_movements.qty_delta` has `CHECK (qty_delta <> 0)`, so a pure cost adjustment cannot be stored as
a movement row under the current constraint. **Resolution**: relax the check to
`CHECK (qty_delta <> 0 OR movement_type = 'adjustment')` and require `reason IS NOT NULL` — already
mandated for adjustments. A zero-quantity, non-zero-cost adjustment is precisely what a cost correction
is, and it must be visible in history (FR-038, US5 scenario 3).

> ⚠️ **The correction row must not collide with the duplicate-write guard.** The unique index
> `(ref_type, ref_id, batch_id)` in §6 already holds the batch's receipt row as
> `('batch', batch_id, batch_id)`. A cost correction that reused those values would collide on the
> **first** correction, and any scheme keyed on the batch alone would collide on the **second** — yet a
> batch may legitimately be corrected more than once (freight now, a wrong rate discovered later).
> **Rule**: a cost-correction adjustment MUST use `ref_type = 'cost_correction'` and
> `ref_id = idempotency_keys.id`, the row claimed for this correction in the same transaction. That id
> is unique per correction and already exists at the point the movement is written, so each correction
> gets a distinct index entry while a genuine retry of the *same* correction still collides and is
> correctly rejected — which is exactly what the guard is for.

A cost change produces a movement row and nothing else: it never alters `qty_remaining`, and it never
rewrites an earlier movement.

Already-recorded `sale_lines` are **never** rewritten; their frozen `unit_cost_minor_at_sale` stands.

---

## 6. `stock_movements` — append-only ledger (FR-009, FR-010)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `batch_id` | `BIGINT` NOT NULL → batches | |
| `movement_type` | `TEXT` NOT NULL | `receipt`, `sale`, `sale_return`, `vendor_return`, `adjustment`, `write_off` |
| `qty_delta` | `INTEGER` NOT NULL | `CHECK (qty_delta <> 0)`; + inbound, − outbound |
| `cost_minor` | `BIGINT` NOT NULL | signed COGS for this movement, from the allocation above |
| `reason` | `TEXT` NULL | **required** for `adjustment` and `write_off` (FR-009, FR-012) |
| `ref_type` | `TEXT` NOT NULL | `sale_line`, `batch`, `stock_count`, `cost_correction` (§5) |
| `ref_id` | `BIGINT` NOT NULL | |
| `created_at` | `TIMESTAMPTZ` NOT NULL DEFAULT now() | |
| `created_by` | `TEXT` NOT NULL → users | FR-032 |

**Constraints**
```sql
CHECK (qty_delta <> 0 OR movement_type = 'adjustment')   -- zero-qty cost corrections (FR-007a)
CHECK (movement_type NOT IN ('adjustment','write_off') OR reason IS NOT NULL)
CREATE UNIQUE INDEX ON stock_movements (ref_type, ref_id, batch_id);  -- duplicate-write guard (D9)
CREATE INDEX ON stock_movements (batch_id, id);
```

**Append-only enforced at the database, not by convention** (Principle II):
```sql
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

CREATE TRIGGER no_update_delete BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
```

FR-042 forbids permanent deletion of **any** sale, purchase, stock movement, or capital record — not
just movements. Protection is therefore table-wide, but in **two tiers**, because some of these tables
have columns that legitimately advance.

| Tier | Tables | Trigger |
|---|---|---|
| Fully immutable | `stock_movements`, `capital_events`, `cash_events` | `BEFORE UPDATE OR DELETE` |
| Delete-protected only | `sales`, `sale_lines`, `batches`, `funding_allocations` | `BEFORE DELETE` |

`sales` and `sale_lines` are not fully immutable: `sales.status`, `sales.voided_*`, and
`sale_lines.qty_returned` advance as returns and voids are recorded (§13). `batches` is likewise
mutable by design — `qty_remaining` and the cost columns change.

> ⚠️ **`funding_allocations` must be UPDATE-able.** FR-026 requires the funding split to keep summing to
> `total_cost_minor`, and §5 changes `total_cost_minor` whenever a landed cost is added or a rate is
> corrected. Re-balancing the allocation in that same transaction is therefore mandatory — so a
> `BEFORE UPDATE` trigger here would make `addLandedCost` and `correctBatchCost` throw on **every**
> call. Delete protection is what FR-042 actually needs; immutability would contradict FR-026.

Corrections are new reversing rows. Never deletions.

---

## 7. `sales` and `sale_lines` — FR-014 … FR-022

### `sales`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `sale_number` | `TEXT` NOT NULL UNIQUE | human reference |
| `sold_at` | `TIMESTAMPTZ` NOT NULL DEFAULT now() | |
| `status` | `TEXT` NOT NULL | `completed`, `partially_returned`, `returned`, `voided` |
| `payment_method` | `TEXT` NOT NULL | label only — `cash`, `card` (Assumptions) |
| `revenue_minor` | `BIGINT` NOT NULL | Σ lines |
| `cost_minor` | `BIGINT` NOT NULL | Σ lines |
| `profit_minor` | `BIGINT` NOT NULL | `revenue_minor − cost_minor`; **may be negative** (FR-017) |
| `voided_at`, `voided_by`, `void_reason` | | FR-022 |
| `created_at`, `created_by` | | FR-032 |

### `sale_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `sale_id` | `BIGINT` NOT NULL → sales | |
| `batch_id` | `BIGINT` NOT NULL → batches | **explicitly chosen** (FR-018) |
| `product_id` | `BIGINT` NOT NULL → products | |
| `quantity` | `INTEGER` NOT NULL | `CHECK (quantity > 0)` |
| `unit_price_minor` | `BIGINT` NOT NULL | set per line, independent of catalogue (FR-015) |
| **`vendor_id_at_sale`** | `BIGINT` NOT NULL | frozen snapshot |
| **`grade_id_at_sale`** | `BIGINT` NOT NULL | frozen snapshot |
| **`unit_cost_minor_at_sale`** | `BIGINT` NOT NULL | frozen snapshot |
| `revenue_minor` | `BIGINT` NOT NULL | `unit_price_minor * quantity` |
| `cost_minor` | `BIGINT` NOT NULL | from batch allocation |
| `profit_minor` | `BIGINT` NOT NULL | `revenue − cost`, signed (FR-017) |
| `qty_returned` | `INTEGER` NOT NULL DEFAULT 0 | `CHECK (qty_returned BETWEEN 0 AND quantity)` |

**The three frozen columns are the heart of FR-016 and FR-038.** They are copies, not joins — so a later
cost correction on the batch cannot retroactively rewrite what a past sale earned. US5 scenario 3
depends on exactly this.

**Splitting across batches** (FR-018b, edge case): a customer buying more than one batch holds produces
multiple `sale_lines` for the same `product_id` within one sale, each with its own `batch_id` and cost.

---

## 8. `capital_events` — FR-024, FR-025

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `event_type` | `TEXT` NOT NULL | `injection` \| `withdrawal` |
| `amount_minor` | `BIGINT` NOT NULL | `CHECK (amount_minor > 0)` — direction lives in `event_type` |
| `occurred_at` | `TIMESTAMPTZ` NOT NULL | |
| `note` | `TEXT` NULL | |
| `created_at`, `created_by` | | FR-032 |

Append-only. A mistaken event is corrected by an opposing event (FR-042).

---

## 9. `funding_allocations` — FR-026 … FR-029

One row per batch, recording how the purchase was paid for.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `batch_id` | `BIGINT` NOT NULL UNIQUE → batches | exactly one per batch |
| `new_capital_minor` | `BIGINT` NOT NULL | `CHECK (>= 0)` |
| `reinvested_minor` | `BIGINT` NOT NULL | `CHECK (>= 0)` |
| `created_at`, `created_by` | | |

**The defining invariant (FR-026)** — enforced in the batch transaction, since `total_cost_minor` lives
on another table:

```
new_capital_minor + reinvested_minor = batches.total_cost_minor
```

A batch without a valid funding allocation cannot be saved (SC-004). Adding landed cost later (FR-007)
changes `total_cost_minor`, so the allocation **must be re-balanced in the same transaction** or the
invariant breaks — a real trap worth a dedicated test.

**FR-029 settled**: there is deliberately **no link to a source sale**. Cash is pooled; this table records
only the split. FR-029a caps `reinvested_minor` at **retained sale proceeds** at the moment of the
purchase:

```sql
retained_proceeds =
    (SELECT COALESCE(SUM(amount_minor), 0) FROM cash_events
      WHERE direction = 'in' AND source_type = 'sale')
  - (SELECT COALESCE(SUM(amount_minor), 0) FROM cash_events
      WHERE direction = 'out' AND source_type IN ('sale_refund', 'withdrawal'))
  - (SELECT COALESCE(SUM(reinvested_minor), 0) FROM funding_allocations)
```

Proceeds, not profit — recovering the cost of goods and putting it back into stock *is* reinvesting
revenue (FR-029a). Subtracting prior `reinvested_minor` is what stops the same proceeds being
reinvested twice; subtracting withdrawals is what stops money being both taken out and redeployed.
Compute this inside the receiving transaction, never read-then-write.

**FR-026a settled**: this table is **descriptive only**. Neither column feeds capital invested or
capital recovered — those come solely from `capital_events` (§12). The split answers "did this stock
come from my pocket or from trading?", which is a reporting question, not an accounting total.

---

## 10. `cash_events` — FR-030, FR-031

Every movement of money, append-only. `cash_on_hand` is derived, never stored as a mutable total.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `direction` | `TEXT` NOT NULL | `in` \| `out` |
| `amount_minor` | `BIGINT` NOT NULL | `CHECK (amount_minor > 0)` |
| `source_type` | `TEXT` NOT NULL | `capital_injection`, `withdrawal`, `sale`, `sale_refund`, `purchase_payment`, `vendor_refund` |
| `source_id` | `BIGINT` NOT NULL | |
| `occurred_at` | `TIMESTAMPTZ` NOT NULL | |
| `created_at`, `created_by` | | |

```sql
CREATE UNIQUE INDEX ON cash_events (source_type, source_id);  -- one cash effect per business event
```

```
cash_on_hand = Σ(direction='in') − Σ(direction='out')
```

A `vendor_refund` event's `amount_minor` is **derived from the batch**, never supplied by the caller:
it equals the effective cost of the units being returned (FR-023). Partial credits and restocking fees
are out of scope (FR-023a), so a vendor return can never move profit and never breaks Invariant B.

FR-031 refuses any withdrawal or purchase payment driving this below zero, checked **inside** the
transaction against a locked balance, not read-then-write.

**Known limitation, accepted in clarification 4**: expenses paid from the till are invisible to this
ledger unless recorded as withdrawals. `cash_on_hand` is therefore cash *attributable to trading and
capital*, not a count of physical notes (FR-035b).

---

## 11. `idempotency_keys` — Constitution Principle I, D9

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` IDENTITY PK | |
| `scope` | `TEXT` NOT NULL | user id / terminal id |
| `key` | `TEXT` NOT NULL | `CHECK (char_length(key) BETWEEN 8 AND 100)` |
| `action_name` | `TEXT` NOT NULL | |
| `request_hash` | `TEXT` NOT NULL | SHA-256 of canonicalized payload |
| `status` | `TEXT` NOT NULL | `in_progress` \| `succeeded` \| `failed` |
| `response_body` | `JSONB` NULL | replayed verbatim on duplicate |
| `locked_at` | `TIMESTAMPTZ` NOT NULL DEFAULT now() | |
| `expires_at` | `TIMESTAMPTZ` NOT NULL DEFAULT now() + INTERVAL '72 hours' | |

```sql
CREATE UNIQUE INDEX idem_scope_key ON idempotency_keys (scope, key);  -- IS the concurrency control
CREATE INDEX idem_expiry ON idempotency_keys (expires_at);
```

Claimed with `INSERT ... ON CONFLICT DO NOTHING RETURNING id` in the **same transaction** as the business
write. `request_hash` mismatch on a reused key → 422, never a silently wrong receipt.

---

## 12. Derived values and invariants

None of these are stored as mutable totals; all are computed from the ledgers.

| Value | Derivation | Requirement |
|---|---|---|
| On-hand per product | `Σ batches.qty_remaining WHERE product_id = ?` | FR-010, FR-036 |
| Profit to date | `Σ sale_lines.profit_minor − Σ write-off cost − Σ cost-correction adjustment cost − reversals` | FR-035 (gross only), FR-007a |
| **Capital invested** | **`Σ capital_events(injection)`** — injections only | FR-033a |
| Capital recovered | `Σ capital_events(withdrawal)` | FR-033a |
| Cash on hand | `Σ cash_events in − Σ cash_events out` | FR-030 |
| Inventory at cost | `Σ costOfUnits(consumed, qty_received)` over open batches, using each batch's **current** `total_cost_minor` | FR-033, FR-007a |

> ⚠️ **Capital invested was previously defined as `Σ injections + Σ funding_allocations.new_capital_minor`.
> That double-counted every injection the moment it was spent and made Invariant B fail on the first
> purchase.** Clarified 2026-10-09: `funding_allocations` is a descriptive record of how pooled cash was
> deployed and contributes nothing to capital invested or recovered (FR-026a). It still carries the
> FR-026 sum-to-total constraint and the FR-029a reinvestment cap — it simply does not feed the summary
> totals.

### Invariant A — ledger reconciliation (Principle II). Must return zero rows, always.

```sql
SELECT b.id
  FROM batches b
  LEFT JOIN stock_movements m ON m.batch_id = b.id
 GROUP BY b.id, b.qty_remaining
HAVING b.qty_remaining <> COALESCE(SUM(m.qty_delta), 0);
```

### Invariant B — the accounting identity (SC-003), exact to the minor unit

```
capital_invested − capital_recovered + profit_to_date = cash_on_hand + inventory_at_cost
```

Worked example, including the case that previously broke it — inject 1000; buy a batch of 10 for 1000;
sell 5 at 150; then add 200 of landed cost:

| After | invested | recovered | profit | cash | inventory | LHS | RHS |
|---|---|---|---|---|---|---|---|
| inject 1000 | 1000 | 0 | 0 | 1000 | 0 | 1000 | 1000 |
| buy 10 @ 1000 | 1000 | 0 | 0 | 0 | 1000 | 1000 | 1000 |
| sell 5 @ 150 | 1000 | 0 | 250 | 750 | 500 | 1250 | 1250 |
| +200 landed cost | 1000 | 0 | 150 | 550 | 600 | 1150 | 1150 |

The last row only balances because the cost correction books a `delta = 100` adjustment against profit
(FR-007a) **and** capital invested stays at 1000 rather than rising with the funding split.

### Invariant C — cost allocation closure (FR-007)

For any fully depleted batch: `Σ stock_movements.cost_minor = batches.total_cost_minor`, exactly.

All three run as assertions at the end of every integration test and as a nightly cron guarded by
`pg_advisory_xact_lock` (D8).

---

## 13. State transitions

**Sale**: `completed` → `partially_returned` → `returned`; `completed` → `voided`. Terminal states are
`returned` and `voided`. Every transition writes reversing ledger rows; nothing is deleted (FR-021,
FR-022, FR-042).

**Batch**: `open` (`qty_remaining > 0`) → `depleted` (`= 0`). Depleted batches stay queryable for history
but **must not appear in the till's batch picker** (edge case).

**Idempotency key**: `in_progress` → `succeeded` \| `failed`; expired keys are reaped after 72h.

---

## 14. Role-based field visibility (FR-041)

Enforced in the Data Access Layer, not the UI. A salesperson's queries must never **select** these
columns — hiding them client-side is not a boundary (FR-041b).

| Table | Hidden from `salesperson` |
|---|---|
| `batches` | `goods_cost_minor`, `landed_cost_minor`, `total_cost_minor` |
| `sale_lines` | `unit_cost_minor_at_sale`, `cost_minor`, `profit_minor` |
| `sales` | `cost_minor`, `profit_minor` |
| `capital_events`, `funding_allocations`, `cash_events` | entire table |

The till's batch picker therefore exposes only vendor, grade, `qty_remaining`, and `received_at`
(FR-018a) — which is precisely why the explicit-selection decision (FR-018) and the role decision
(FR-041) must be designed together.
