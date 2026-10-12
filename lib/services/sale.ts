import "server-only";

/**
 * The sale path (T061, T062). This is the critical path, in both senses.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * OVERSELL IS PREVENTED BY THE GUARDED CONDITIONAL UPDATE, AND BY NOTHING ELSE.
 *
 *     UPDATE batches SET qty_remaining = qty_remaining - $qty
 *      WHERE id = $batchId AND qty_remaining >= $qty
 *     RETURNING ...
 *
 * Postgres takes a row lock for the duration of the UPDATE, re-evaluating the WHERE against the
 * latest committed version, so of N concurrent attempts on the last unit exactly one matches a
 * row. `rowCount === 0` means someone else got there first — a DOMAIN error, not a failure.
 *
 * What this must never become:
 *   - SELECT qty_remaining, then decide, then UPDATE. Two readers both see 1 and both sell it.
 *   - A check in application code before the UPDATE. Same race, more code.
 *   - Relying on `CHECK (qty_remaining >= 0)`. That is a BACKSTOP. If SQLSTATE 23514 ever
 *     reaches a caller, the guard was bypassed and that is a bug, not a safe rejection.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * NO NETWORK I/O INSIDE THE TRANSACTION. Every statement here is database work. An HTTP call to
 * a receipt printer or analytics service would hold a PgBouncer backend for its whole duration
 * and is how a till at peak exhausts the pool.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { batches, cashEvents, saleLines, sales, stockMovements } from "@/lib/db/schema";
import { batchCostSlice } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { DomainError } from "@/lib/services/domain-error";
import { messages } from "@/lib/types/action-result";

type Actor = string;

export type SaleLineInput = {
  /** EXPLICIT. There is no automatic batch selection (FR-018) — the seller chooses. */
  batchId: number;
  quantity: number;
  /** May be below cost; selling at a loss is a legitimate business decision (FR-017). */
  unitPriceMinor: number;
};

export type RecordSaleInput = {
  paymentMethod: "cash" | "card";
  lines: SaleLineInput[];
};

export type RecordSaleResult = {
  saleId: number;
  saleNumber: string;
  revenueMinor: number;
  /** Omitted for a salesperson by the caller — never sent to a client that must not see it. */
  costMinor?: number;
  profitMinor?: number;
  lines: Array<{ saleLineId: number; batchId: number; quantity: number; revenueMinor: number }>;
};

/**
 * Record a sale. ALL basket lines in ONE call.
 *
 * Server Actions dispatch sequentially per client, so one action per scanned item would
 * serialise the entire basket behind a round trip each — and would make a partially-committed
 * basket possible, which is worse.
 */
export async function recordSale(
  tx: Tx,
  actor: Actor,
  input: RecordSaleInput,
): Promise<RecordSaleResult> {
  if (input.lines.length === 0) {
    throw new DomainError("VALIDATION", "A sale needs at least one line.");
  }

  let revenueMinor = 0;
  let costMinor = 0;
  const lineResults: RecordSaleResult["lines"] = [];
  const pending: Array<{
    batchId: number;
    quantity: number;
    unitPriceMinor: number;
    lineRevenue: number;
    lineCost: number;
    vendorId: number;
    gradeId: number;
    productId: number;
  }> = [];

  // --- Phase 1: take the stock. Guarded UPDATE per line. ---
  for (const line of input.lines) {
    if (line.quantity <= 0) {
      throw new DomainError("VALIDATION", "Quantity must be at least 1.");
    }

    const claimed = await tx
      .update(batches)
      .set({ qtyRemaining: sql`${batches.qtyRemaining} - ${line.quantity}` })
      .where(
        and(eq(batches.id, line.batchId), sql`${batches.qtyRemaining} >= ${line.quantity}`),
      )
      .returning({
        qtyReceived: batches.qtyReceived,
        qtyRemaining: batches.qtyRemaining,
        totalCostMinor: batches.totalCostMinor,
        vendorId: batches.vendorId,
        gradeId: batches.gradeId,
        productId: batches.productId,
      });

    // THE check. Zero rows matched means the stock went to someone else between this
    // transaction starting and this statement running.
    if (claimed.length === 0) {
      const [existing] = await tx
        .select({ qtyRemaining: batches.qtyRemaining })
        .from(batches)
        .where(eq(batches.id, line.batchId))
        .limit(1);

      if (!existing) throw new DomainError("NOT_FOUND", "That batch no longer exists.");
      throw new DomainError(
        "INSUFFICIENT_STOCK",
        messages.insufficientStock(existing.qtyRemaining, line.quantity),
      );
    }

    const b = claimed[0];
    const consumedAfter = b.qtyReceived - b.qtyRemaining;
    const consumedBefore = consumedAfter - line.quantity;

    // Prefix-difference allocation — the same function the property tests pin.
    const lineCost = batchCostSlice(
      minor(b.totalCostMinor) as Minor,
      b.qtyReceived,
      consumedBefore,
      consumedAfter,
    );
    const lineRevenue = line.unitPriceMinor * line.quantity;

    revenueMinor += lineRevenue;
    costMinor += lineCost;

    pending.push({
      batchId: line.batchId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineRevenue,
      lineCost,
      vendorId: b.vendorId,
      gradeId: b.gradeId,
      productId: b.productId,
    });
  }

  // --- Phase 2: the sale header. ---
  const saleNumber = await nextSaleNumber(tx);
  const [sale] = await tx
    .insert(sales)
    .values({
      saleNumber,
      status: "completed",
      paymentMethod: input.paymentMethod,
      revenueMinor,
      costMinor,
      // MAY BE NEGATIVE — selling below cost is allowed and must be recorded honestly (FR-017).
      profitMinor: revenueMinor - costMinor,
      createdBy: actor,
    })
    .returning({ id: sales.id });

  // --- Phase 3: lines, each FREEZING its attribution. ---
  for (const p of pending) {
    const [line] = await tx
      .insert(saleLines)
      .values({
        saleId: sale.id,
        batchId: p.batchId,
        productId: p.productId,
        quantity: p.quantity,
        unitPriceMinor: p.unitPriceMinor,
        /**
         * COPIES, not joins. A later cost correction on the batch must not retroactively
         * rewrite what this sale earned — US5 scenario 3 depends on exactly this.
         */
        vendorIdAtSale: p.vendorId,
        gradeIdAtSale: p.gradeId,
        unitCostMinorAtSale: Math.floor(p.lineCost / p.quantity),
        revenueMinor: p.lineRevenue,
        costMinor: p.lineCost,
        profitMinor: p.lineRevenue - p.lineCost,
      })
      .returning({ id: saleLines.id });

    await tx.insert(stockMovements).values({
      batchId: p.batchId,
      movementType: "sale",
      qtyDelta: -p.quantity,
      costMinor: p.lineCost,
      refType: "sale_line",
      refId: line.id,
      createdBy: actor,
    });

    lineResults.push({
      saleLineId: line.id,
      batchId: p.batchId,
      quantity: p.quantity,
      revenueMinor: p.lineRevenue,
    });
  }

  /**
   * --- Phase 4: the money. ---
   *
   * Skipped entirely when revenue is zero, which happens when stock is given away — a sample, a
   * goodwill replacement. No money moved, so there is no cash event to record: a zero-amount row
   * would be a meaningless ledger entry, and `cash_events_amount_positive` rejects it outright.
   *
   * The sale itself is still recorded in full, with its cost and a negative profit, so giving
   * stock away correctly shows up as a loss rather than vanishing.
   */
  if (revenueMinor > 0) {
    await tx.insert(cashEvents).values({
      direction: "in",
      amountMinor: revenueMinor,
      sourceType: "sale",
      sourceId: sale.id,
      occurredAt: new Date(),
      createdBy: actor,
    });
  }

  return {
    saleId: sale.id,
    saleNumber,
    revenueMinor,
    costMinor,
    profitMinor: revenueMinor - costMinor,
    lines: lineResults,
  };
}

/**
 * Human-readable sale number, from a Postgres SEQUENCE.
 *
 * O(1) and concurrency-safe. Sequences are non-transactional, so a rolled-back sale burns a
 * number and leaves a gap — correct here, because sale_number is a human reference rather than
 * an invoice number, and a gap honestly records that an attempt happened.
 *
 * The previous version took MAX(regexp_replace(sale_number, ...)) over the whole sales table on
 * every sale. It was fast in testing and linear in a year of trading.
 */
async function nextSaleNumber(tx: Tx): Promise<string> {
  const rows = await tx.execute(sql`SELECT nextval('sale_number_seq') AS next`);
  const first = (
    Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
  )[0] as { next?: number | string } | undefined;
  return `S-${String(Number(first?.next ?? 1)).padStart(5, "0")}`;
}

/** Strip cost and profit for a salesperson (FR-041, SC-010). */
export function redactForRole(
  result: RecordSaleResult,
  role: "owner" | "salesperson",
): RecordSaleResult {
  if (role === "owner") return result;
  // Deleted rather than zeroed: a zero is a value a client could mistake for real data, and
  // an absent key is what the SC-010 test asserts on.
  const redacted = { ...result };
  delete redacted.costMinor;
  delete redacted.profitMinor;
  return redacted;
}
