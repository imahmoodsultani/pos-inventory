/**
 * Drizzle schema — data-model.md §1-§11.
 *
 * Conventions that are not negotiable (CLAUDE.md § Money, § Database):
 *   - every monetary column is BIGINT minor units, never numeric, never a float;
 *   - every timestamp is TIMESTAMPTZ generated server-side;
 *   - no transactional row is ever hard-deleted (FR-042), enforced by trigger in the migration.
 *
 * drizzle-kit cannot express generated columns, partial/expression unique indexes, or triggers.
 * Those are hand-added to the generated SQL in T017/T018/T019 — see drizzle/ and the comments
 * marked HAND-EDIT below.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** BIGINT money. `mode: "number"` plus the OID 20 parser in ./types.ts keeps it off strings. */
const money = (name: string) => bigint(name, { mode: "number" });

/** Identity primary key. */
const id = () => bigserial("id", { mode: "number" }).primaryKey();

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** FR-032 — every mutating row carries its actor. */
const createdBy = () => text("created_by").notNull();

// ---------------------------------------------------------------------------
// 1. Better Auth tables (data-model §1)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // HAND-EDIT: CHECK (role IN ('owner','salesperson')). Assigned server-side only — never
  // read from client input (FR-041).
  role: text("role").notNull().default("salesperson"),
  // FR-041a — deactivate, never delete. The last active owner cannot be deactivated.
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 2-4. Catalogue (data-model §2-§4)
// ---------------------------------------------------------------------------

export const vendors = pgTable("vendors", {
  id: id(),
  // HAND-EDIT: UNIQUE (lower(name)) — case-insensitive, which drizzle-kit cannot express.
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const qualityGrades = pgTable("quality_grades", {
  id: id(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const products = pgTable("products", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  // HAND-EDIT: CHECK (unit_of_measure IN ('piece','box','pack','pair')).
  // FR-001 — discrete countable units only. Weight and length are forbidden: all quantities are
  // INTEGER, so a fractional unit could be stored but never transacted.
  unitOfMeasure: text("unit_of_measure").notNull().default("piece"),
  // FR-039. Zero means NOT SET, and such products are excluded from the low-stock list —
  // otherwise every product with the default reports as low stock forever.
  reorderLevel: integer("reorder_level").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

// ---------------------------------------------------------------------------
// 5. batches — the anchor of all cost attribution (data-model §5)
// ---------------------------------------------------------------------------

export const batches = pgTable(
  "batches",
  {
    id: id(),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id),
    vendorId: bigint("vendor_id", { mode: "number" })
      .notNull()
      .references(() => vendors.id),
    gradeId: bigint("grade_id", { mode: "number" })
      .notNull()
      .references(() => qualityGrades.id),
    // Backdating is allowed (edge case): stock received before the system went live.
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    reference: text("reference"),
    // HAND-EDIT: CHECK (qty_received > 0)
    qtyReceived: integer("qty_received").notNull(),
    // Denormalized cache, permitted by Principle II because Invariant A reconstructs it.
    // Maintained ONLY by the guarded conditional UPDATE in the sale transaction — never by a
    // trigger, so the concurrency mechanism stays visible in application code.
    // HAND-EDIT: CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received) — a BACKSTOP.
    // If SQLSTATE 23514 ever reaches a caller, that is a bug in the guarded UPDATE.
    qtyRemaining: integer("qty_remaining").notNull(),
    goodsCostMinor: money("goods_cost_minor").notNull(),
    landedCostMinor: money("landed_cost_minor").notNull().default(0),
    // Declared generated so Drizzle EXCLUDES it from inserts and updates. Without this the
    // insert type demands a value, and supplying one is an error Postgres rejects outright:
    // the column is GENERATED ALWAYS, computed from the two cost columns above.
    totalCostMinor: money("total_cost_minor")
      .notNull()
      .generatedAlwaysAs(sql`goods_cost_minor + landed_cost_minor`),
    // FR-038 / US5 scenario 3 — flags that history contains a correction adjustment.
    isCostCorrected: boolean("is_cost_corrected").notNull().default(false),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    // The till's batch picker: open batches for one product.
    index("batches_product_remaining_idx").on(t.productId, t.qtyRemaining),
    index("batches_vendor_idx").on(t.vendorId),
    index("batches_grade_idx").on(t.gradeId),
    index("batches_product_received_idx").on(t.productId, t.receivedAt, t.id),
  ],
);

// ---------------------------------------------------------------------------
// 6. stock_movements — append-only ledger (data-model §6)
// ---------------------------------------------------------------------------

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id),
    // receipt | sale | sale_return | vendor_return | adjustment | write_off
    movementType: text("movement_type").notNull(),
    // HAND-EDIT: CHECK (qty_delta <> 0 OR movement_type = 'adjustment').
    // Zero-quantity adjustments are how FR-007a cost corrections are recorded: a real cost
    // change attributed to units already sold, carrying cost but no quantity.
    qtyDelta: integer("qty_delta").notNull(),
    costMinor: money("cost_minor").notNull(),
    // HAND-EDIT: CHECK (movement_type NOT IN ('adjustment','write_off') OR reason IS NOT NULL)
    reason: text("reason"),
    // sale_line | batch | stock_count | cost_correction
    //
    // A cost correction MUST use ref_type = 'cost_correction' with ref_id = idempotency_keys.id.
    // Reusing ('batch', batchId) collides with the batch's own receipt row on the unique index
    // below — on the FIRST correction. Keying on the batch alone collides on the second, and a
    // batch may legitimately be corrected more than once (freight now, a wrong rate later).
    refType: text("ref_type").notNull(),
    refId: bigint("ref_id", { mode: "number" }).notNull(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    // Duplicate-write guard (D9). Also what makes a genuine retry of the same correction fail.
    uniqueIndex("stock_movements_ref_idx").on(t.refType, t.refId, t.batchId),
    index("stock_movements_batch_idx").on(t.batchId, t.id),
  ],
);

// ---------------------------------------------------------------------------
// 7. sales and sale_lines (data-model §7)
// ---------------------------------------------------------------------------

export const sales = pgTable("sales", {
  id: id(),
  saleNumber: text("sale_number").notNull().unique(),
  soldAt: timestamp("sold_at", { withTimezone: true }).notNull().defaultNow(),
  // HAND-EDIT: CHECK (status IN ('completed','partially_returned','returned','voided'))
  status: text("status").notNull().default("completed"),
  // Label only — this app takes no payment (Assumptions).
  paymentMethod: text("payment_method").notNull(),
  revenueMinor: money("revenue_minor").notNull(),
  costMinor: money("cost_minor").notNull(),
  // MAY BE NEGATIVE — selling below cost is explicitly allowed (FR-017).
  profitMinor: money("profit_minor").notNull(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const saleLines = pgTable(
  "sale_lines",
  {
    id: id(),
    saleId: bigint("sale_id", { mode: "number" })
      .notNull()
      .references(() => sales.id),
    // Explicitly chosen by the seller — there is no automatic batch selection (FR-018).
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id),
    // HAND-EDIT: CHECK (quantity > 0)
    quantity: integer("quantity").notNull(),
    unitPriceMinor: money("unit_price_minor").notNull(),

    // --- The three frozen columns: the heart of FR-016 and FR-038. ---
    // These are COPIES, not joins. A later cost correction on the batch must not retroactively
    // rewrite what a past sale earned; US5 scenario 3 depends on exactly this.
    vendorIdAtSale: bigint("vendor_id_at_sale", { mode: "number" }).notNull(),
    gradeIdAtSale: bigint("grade_id_at_sale", { mode: "number" }).notNull(),
    unitCostMinorAtSale: money("unit_cost_minor_at_sale").notNull(),

    revenueMinor: money("revenue_minor").notNull(),
    costMinor: money("cost_minor").notNull(),
    profitMinor: money("profit_minor").notNull(),
    // HAND-EDIT: CHECK (qty_returned BETWEEN 0 AND quantity)
    qtyReturned: integer("qty_returned").notNull().default(0),
  },
  (t) => [
    index("sale_lines_sale_idx").on(t.saleId),
    index("sale_lines_batch_idx").on(t.batchId),
    index("sale_lines_product_idx").on(t.productId),
  ],
);

// ---------------------------------------------------------------------------
// 8. capital_events (data-model §8)
// ---------------------------------------------------------------------------

export const capitalEvents = pgTable("capital_events", {
  id: id(),
  // HAND-EDIT: CHECK (event_type IN ('injection','withdrawal'))
  eventType: text("event_type").notNull(),
  // HAND-EDIT: CHECK (amount_minor > 0). Direction lives in event_type, never in the sign.
  amountMinor: money("amount_minor").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

// ---------------------------------------------------------------------------
// 9. funding_allocations (data-model §9)
// ---------------------------------------------------------------------------

/**
 * DESCRIPTIVE ONLY (FR-026a). Neither column feeds capital invested or capital recovered —
 * those come solely from capital_events. Defining capital invested as
 * `injections + new_capital_minor` double-counts every injection the moment it is spent, and
 * breaks the SC-003 identity on the very first purchase.
 *
 * This table IS update-able, unlike the other ledgers: FR-026 requires the split to keep summing
 * to total_cost_minor, and a landed cost or rate correction changes that total.
 */
export const fundingAllocations = pgTable("funding_allocations", {
  id: id(),
  batchId: bigint("batch_id", { mode: "number" })
    .notNull()
    .unique()
    .references(() => batches.id),
  // HAND-EDIT: CHECK (new_capital_minor >= 0), CHECK (reinvested_minor >= 0).
  // new_capital_minor + reinvested_minor = batches.total_cost_minor is enforced in the
  // transaction, not by a constraint — the total lives on another table.
  newCapitalMinor: money("new_capital_minor").notNull(),
  reinvestedMinor: money("reinvested_minor").notNull(),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

// ---------------------------------------------------------------------------
// 10. cash_events (data-model §10)
// ---------------------------------------------------------------------------

export const cashEvents = pgTable(
  "cash_events",
  {
    id: id(),
    // HAND-EDIT: CHECK (direction IN ('in','out'))
    direction: text("direction").notNull(),
    // HAND-EDIT: CHECK (amount_minor > 0)
    amountMinor: money("amount_minor").notNull(),
    // capital_injection | withdrawal | sale | sale_refund | purchase_payment | vendor_refund
    sourceType: text("source_type").notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    // One cash effect per business event — makes double-posting a sale impossible.
    uniqueIndex("cash_events_source_idx").on(t.sourceType, t.sourceId),
    index("cash_events_occurred_idx").on(t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// 11. idempotency_keys (data-model §11)
// ---------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    scope: text("scope").notNull(),
    // HAND-EDIT: CHECK (char_length(key) BETWEEN 8 AND 100)
    key: text("key").notNull(),
    actionName: text("action_name").notNull(),
    requestHash: text("request_hash").notNull(),
    // HAND-EDIT: CHECK (status IN ('in_progress','succeeded','failed'))
    status: text("status").notNull().default("in_progress"),
    responseBody: jsonb("response_body"),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // This index IS the concurrency control, not merely a constraint: the claim is
    // INSERT ... ON CONFLICT DO NOTHING against it, inside the business transaction.
    uniqueIndex("idem_scope_key").on(t.scope, t.key),
    index("idem_expiry").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// 15. record_edits — the edit audit log (data-model §15)
// ---------------------------------------------------------------------------

/**
 * What replaces immutability where a record became editable.
 *
 * Immutability answered "how did this figure come to be?" by refusing to let it change. Capital
 * events are now correctable in place (FR-042, FR-046), so the question needs answering some other
 * way, and this is it.
 *
 * ONE ROW PER FIELD CHANGED, grouped by `editGroup`. That keeps "every change ever made to this
 * vendor's email" a plain WHERE rather than a JSON path expression, while a multi-field edit still
 * reconstructs as one action.
 */
export const recordEdits = pgTable(
  "record_edits",
  {
    id: id(),
    tableName: text("table_name").notNull(),
    // TEXT, not BIGINT: users.id is a Better Auth text id while everything else is bigint.
    recordId: text("record_id").notNull(),
    fieldName: text("field_name").notNull(),
    // NULL for a secret field — see the deny-list in lib/services/audit.ts — or where there was
    // no prior value.
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason"),
    /** Shared by every row written in one edit. */
    editGroup: text("edit_group").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("record_edits_record_idx").on(t.tableName, t.recordId, t.changedAt)],
);

export type User = typeof users.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type Sale = typeof sales.$inferSelect;
export type SaleLine = typeof saleLines.$inferSelect;
export type CapitalEvent = typeof capitalEvents.$inferSelect;
export type CashEvent = typeof cashEvents.$inferSelect;
export type FundingAllocation = typeof fundingAllocations.$inferSelect;
export type RecordEdit = typeof recordEdits.$inferSelect;
