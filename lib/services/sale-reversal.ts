import "server-only";

/**
 * Returns and voids (T063, FR-021, FR-022, FR-042).
 *
 * Nothing is ever deleted or edited into a different shape. A return writes REVERSING rows:
 * units go back to their original batch, a negative-cost movement undoes the allocation, and a
 * refund cash event goes out. Both the original sale and its reversal stay visible, because the
 * question "what happened here?" must always be answerable.
 *
 * Returned units go back at the ORIGINAL FROZEN COST, not a recomputed one. If the batch's cost
 * was corrected after the sale, recomputing would make the return a different amount from the
 * sale it reverses, and profit would drift by the difference.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { batches, cashEvents, saleLines, sales, stockMovements } from "@/lib/db/schema";
import { batchCostSlice } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { DomainError } from "@/lib/services/domain-error";

type Actor = string;
type Role = "owner" | "salesperson";

export type ReturnLineInput = { saleLineId: number; quantity: number };

/**
 * Undo the share of an FR-007a cost correction that belonged to units now coming back.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. A return reverses the sale line's FROZEN cost — correct, because that is
 * what the sale earned. But returned units re-enter inventory, and inventory is valued at the
 * batch's CURRENT cost. When a cost correction happened in between, those two rates differ and
 * the accounting identity fails by exactly the gap.
 *
 * Worked example: 10 units for 1000, sell 4 at 150, freight raises the batch to 1200, return 2.
 *   - the 2 units re-enter inventory at the new rate:            2 x 120 = 240
 *   - the return reverses the frozen cost:                       2 x 100 = 200
 *   - identity short by                                                     40
 *
 * The FR-007a adjustment booked cost against 4 sold units; only 2 are still sold, so 40 of it
 * no longer applies. This writes that 40 back as a negative adjustment.
 *
 * Computed with the same prefix-difference allocation as everywhere else, so it is exact rather
 * than a per-unit rate multiplied out — which would drift on batches that do not divide evenly.
 *
 * Zero, and therefore a no-op, whenever the batch's cost has not changed since the sale.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */
async function unwindCostCorrection(
  tx: Tx,
  actor: Actor,
  params: {
    batchId: number;
    quantityReturned: number;
    frozenCostReversedMinor: number;
    idempotencyId: number;
    index: number;
    reason: string;
  },
): Promise<void> {
  const [batch] = await tx
    .select({
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      totalCostMinor: batches.totalCostMinor,
      isCostCorrected: batches.isCostCorrected,
    })
    .from(batches)
    .where(eq(batches.id, params.batchId))
    .limit(1);

  // Nothing to unwind if this batch's cost was never corrected.
  if (!batch?.isCostCorrected) return;

  // qty_remaining has already been incremented by the caller, so these bracket the return.
  const consumedAfter = batch.qtyReceived - batch.qtyRemaining;
  const consumedBefore = consumedAfter + params.quantityReturned;

  // What those units are worth at the batch's CURRENT cost.
  const currentRateCost = batchCostSlice(
    minor(batch.totalCostMinor) as Minor,
    batch.qtyReceived,
    consumedAfter,
    consumedBefore,
  );

  const unwindMinor = currentRateCost - params.frozenCostReversedMinor;
  if (unwindMinor === 0) return;

  await tx.insert(stockMovements).values({
    batchId: params.batchId,
    movementType: "adjustment",
    qtyDelta: 0,
    costMinor: -unwindMinor,
    reason: `Cost correction unwound on return: ${params.reason}`,
    refType: "cost_correction",
    // Distinct from the original correction and from other lines in this same reversal.
    refId: params.idempotencyId * 1000 + 500 + params.index,
    createdBy: actor,
  });
}

export type RecordSaleReturnResult = {
  saleId: number;
  status: string;
  refundMinor: number;
  /** Owner only — a salesperson must never receive the reversed cost or profit (FR-021). */
  reversedCostMinor?: number;
  reversedProfitMinor?: number;
};

/**
 * Record a customer return. Either an owner OR a salesperson may do this (FR-021) — returns
 * happen at the counter and must not wait for the owner.
 */
export async function recordSaleReturn(
  tx: Tx,
  actor: Actor,
  role: Role,
  input: { saleId: number; lines: ReturnLineInput[]; reason: string; idempotencyId: number },
): Promise<RecordSaleReturnResult> {
  if (!input.reason?.trim()) {
    throw new DomainError("VALIDATION", "A reason is required for a return.", {
      reason: ["Required"],
    });
  }

  const [sale] = await tx
    .select()
    .from(sales)
    .where(eq(sales.id, input.saleId))
    .limit(1);

  if (!sale) throw new DomainError("NOT_FOUND", "That sale does not exist.");
  if (sale.status === "voided") {
    throw new DomainError("CONFLICT", "That sale was voided; there is nothing to return.");
  }

  let refundMinor = 0;
  let reversedCostMinor = 0;

  for (const [index, line] of input.lines.entries()) {
    if (line.quantity <= 0) {
      throw new DomainError("VALIDATION", "Return quantity must be at least 1.");
    }

    const [row] = await tx
      .select()
      .from(saleLines)
      .where(and(eq(saleLines.id, line.saleLineId), eq(saleLines.saleId, input.saleId)))
      .limit(1);

    if (!row) throw new DomainError("NOT_FOUND", "That sale line is not part of this sale.");

    const alreadyReturned = row.qtyReturned;
    const returnable = row.quantity - alreadyReturned;
    if (line.quantity > returnable) {
      throw new DomainError(
        "CONFLICT",
        `Only ${returnable} of those ${row.quantity} can still be returned.`,
      );
    }

    /**
     * Reverse at the FROZEN unit figures, pro-rata.
     *
     * Deriving from the stored line rather than recomputing from the batch is what keeps a
     * return exactly undoing its sale even if the batch cost has since been corrected.
     */
    const unitRevenue = Math.floor(row.revenueMinor / row.quantity);
    const unitCost = Math.floor(row.costMinor / row.quantity);
    const lineRefund = unitRevenue * line.quantity;
    const lineCost = unitCost * line.quantity;

    refundMinor += lineRefund;
    reversedCostMinor += lineCost;

    // Units go back to their ORIGINAL batch.
    await tx
      .update(batches)
      .set({ qtyRemaining: sql`${batches.qtyRemaining} + ${line.quantity}` })
      .where(eq(batches.id, row.batchId));

    await tx
      .update(saleLines)
      .set({ qtyReturned: alreadyReturned + line.quantity })
      .where(eq(saleLines.id, row.id));

    // Reversing ledger row: positive quantity back in, negative cost un-allocating.
    await tx.insert(stockMovements).values({
      batchId: row.batchId,
      movementType: "sale_return",
      qtyDelta: line.quantity,
      costMinor: -lineCost,
      reason: input.reason,
      refType: "sale_line",
      // Distinct from the original sale movement's (sale_line, row.id) on the unique index.
      refId: input.idempotencyId * 1000 + index,
      createdBy: actor,
    });

    await unwindCostCorrection(tx, actor, {
      batchId: row.batchId,
      quantityReturned: line.quantity,
      frozenCostReversedMinor: lineCost,
      idempotencyId: input.idempotencyId,
      index,
      reason: input.reason,
    });
  }

  // Advance the sale's status from what is now returned in total.
  const remaining = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${saleLines.quantity}), 0)`,
      returned: sql<number>`COALESCE(SUM(${saleLines.qtyReturned}), 0)`,
    })
    .from(saleLines)
    .where(eq(saleLines.saleId, input.saleId));

  const total = Number(remaining[0].total);
  const returned = Number(remaining[0].returned);
  const status = returned >= total ? "returned" : "partially_returned";

  await tx.update(sales).set({ status }).where(eq(sales.id, input.saleId));

  // Money back to the customer — unless the units were given away, in which case there is
  // nothing to refund and no cash event to write (see the same case in recordSale).
  if (refundMinor > 0) {
    await tx.insert(cashEvents).values({
      direction: "out",
      amountMinor: refundMinor,
      sourceType: "sale_refund",
      sourceId: input.idempotencyId,
      occurredAt: new Date(),
      createdBy: actor,
    });
  }

  const result: RecordSaleReturnResult = { saleId: input.saleId, status, refundMinor };

  // FR-021 — a salesperson sees the refund they must hand over, and nothing else.
  if (role === "owner") {
    result.reversedCostMinor = reversedCostMinor;
    result.reversedProfitMinor = refundMinor - reversedCostMinor;
  }
  return result;
}

/**
 * Void an entire sale. OWNER ONLY (FR-022).
 *
 * Voiding is for a sale that should never have been recorded — a mis-scan, a training mistake.
 * It reverses every line in full. The role restriction is the point: a salesperson can undo a
 * customer's purchase (a return, with cash moving visibly) but cannot make a whole sale
 * disappear from the day's takings.
 */
export async function recordSaleVoid(
  tx: Tx,
  actor: Actor,
  input: { saleId: number; reason: string; idempotencyId: number },
): Promise<{ saleId: number; status: "voided"; reversedRevenueMinor: number }> {
  if (!input.reason?.trim()) {
    throw new DomainError("VALIDATION", "A reason is required to void a sale.", {
      reason: ["Required"],
    });
  }

  const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).limit(1);
  if (!sale) throw new DomainError("NOT_FOUND", "That sale does not exist.");
  if (sale.status === "voided") {
    throw new DomainError("CONFLICT", "That sale is already voided.");
  }

  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, input.saleId));

  let reversedRevenueMinor = 0;

  for (const [index, row] of lines.entries()) {
    const outstanding = row.quantity - row.qtyReturned;
    if (outstanding <= 0) continue;

    const unitRevenue = Math.floor(row.revenueMinor / row.quantity);
    const unitCost = Math.floor(row.costMinor / row.quantity);
    reversedRevenueMinor += unitRevenue * outstanding;

    await tx
      .update(batches)
      .set({ qtyRemaining: sql`${batches.qtyRemaining} + ${outstanding}` })
      .where(eq(batches.id, row.batchId));

    await tx
      .update(saleLines)
      .set({ qtyReturned: row.quantity })
      .where(eq(saleLines.id, row.id));

    await tx.insert(stockMovements).values({
      batchId: row.batchId,
      movementType: "sale_return",
      qtyDelta: outstanding,
      costMinor: -(unitCost * outstanding),
      reason: `Void: ${input.reason}`,
      refType: "sale_line",
      refId: input.idempotencyId * 1000 + index,
      createdBy: actor,
    });

    // A void is a full return, so it needs the same cost-correction unwind.
    await unwindCostCorrection(tx, actor, {
      batchId: row.batchId,
      quantityReturned: outstanding,
      frozenCostReversedMinor: unitCost * outstanding,
      idempotencyId: input.idempotencyId,
      index,
      reason: `Void: ${input.reason}`,
    });
  }

  await tx
    .update(sales)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: actor,
      voidReason: input.reason,
    })
    .where(eq(sales.id, input.saleId));

  if (reversedRevenueMinor > 0) {
    await tx.insert(cashEvents).values({
      direction: "out",
      amountMinor: reversedRevenueMinor,
      sourceType: "sale_refund",
      sourceId: input.idempotencyId,
      occurredAt: new Date(),
      createdBy: actor,
    });
  }

  // The sale row itself survives, voided and annotated. FR-042: nothing is ever deleted.
  return { saleId: input.saleId, status: "voided", reversedRevenueMinor };
}
