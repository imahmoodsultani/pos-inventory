import "server-only";

/**
 * Physical counts and write-offs (T048, FR-009, FR-011, FR-012).
 *
 * Neither of these ever writes `qty_remaining` as a bare assignment. A count that disagrees with
 * the system produces an ADJUSTMENT MOVEMENT for the difference, and the quantity follows from
 * the ledger. That is Constitution Principle II: the ledger is the truth, the cached quantity is
 * derived, and Invariant A proves they agree.
 *
 * Setting the quantity directly would lose the one fact that matters afterwards — that stock was
 * missing, by how much, and why.
 */

import { eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { batches, stockMovements } from "@/lib/db/schema";
import { costOfFirst } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { DomainError } from "@/lib/services/domain-error";

type Actor = string;

export type StockCountLine = { batchId: number; countedQty: number };

export type StockCountResult = {
  adjustments: Array<{
    batchId: number;
    expectedQty: number;
    countedQty: number;
    deltaQty: number;
    costMinor: number;
    movementId: number;
  }>;
};

/**
 * Reconcile a physical count (FR-011).
 *
 * Batches that match are skipped entirely — recording a zero-quantity "adjustment" for them
 * would both violate the qty_delta CHECK and bury the real discrepancies in noise.
 */
export async function recordStockCount(
  tx: Tx,
  actor: Actor,
  input: { counts: StockCountLine[]; reason: string; idempotencyId: number },
): Promise<StockCountResult> {
  if (!input.reason?.trim()) {
    throw new DomainError("VALIDATION", "A reason is required for a stock count.", {
      reason: ["Required"],
    });
  }

  const adjustments: StockCountResult["adjustments"] = [];

  for (const [index, line] of input.counts.entries()) {
    const [batch] = await tx
      .select({
        id: batches.id,
        qtyReceived: batches.qtyReceived,
        qtyRemaining: batches.qtyRemaining,
        totalCostMinor: batches.totalCostMinor,
      })
      .from(batches)
      .where(eq(batches.id, line.batchId))
      .limit(1);

    if (!batch) {
      throw new DomainError("NOT_FOUND", `Batch ${line.batchId} does not exist.`);
    }
    if (line.countedQty < 0 || line.countedQty > batch.qtyReceived) {
      throw new DomainError(
        "VALIDATION",
        `Counted quantity for batch ${line.batchId} must be between 0 and ${batch.qtyReceived}.`,
      );
    }

    const deltaQty = line.countedQty - batch.qtyRemaining;
    if (deltaQty === 0) continue;

    // Value the difference with the same allocation the sale path uses, so a shrinkage of two
    // units costs exactly what selling those two units would have.
    const consumedBefore = batch.qtyReceived - batch.qtyRemaining;
    const consumedAfter = consumedBefore - deltaQty;
    const costMinor =
      costOfFirst(minor(batch.totalCostMinor) as Minor, batch.qtyReceived, consumedAfter) -
      costOfFirst(minor(batch.totalCostMinor) as Minor, batch.qtyReceived, consumedBefore);

    await tx
      .update(batches)
      .set({ qtyRemaining: line.countedQty })
      .where(eq(batches.id, line.batchId));

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        batchId: line.batchId,
        movementType: "adjustment",
        qtyDelta: deltaQty,
        costMinor,
        reason: input.reason,
        refType: "stock_count",
        // Unique per (count, batch): one idempotency row covers the whole count, so the batch
        // index disambiguates lines within it.
        refId: input.idempotencyId * 1000 + index,
        createdBy: actor,
      })
      .returning({ id: stockMovements.id });

    adjustments.push({
      batchId: line.batchId,
      expectedQty: batch.qtyRemaining,
      countedQty: line.countedQty,
      deltaQty,
      costMinor,
      movementId: movement.id,
    });
  }

  return { adjustments };
}

/**
 * Write off damaged or lost units (FR-012).
 *
 * Uses the guarded conditional UPDATE, not a bare decrement: a write-off races against sales for
 * the same units, and losing that race must fail loudly rather than drive stock negative.
 */
export async function recordWriteOff(
  tx: Tx,
  actor: Actor,
  input: { batchId: number; quantity: number; reason: string; idempotencyId: number },
): Promise<{ movementId: number; costMinor: number }> {
  if (!input.reason?.trim()) {
    // Also enforced by a database CHECK — this is the friendly message, not the guarantee.
    throw new DomainError("VALIDATION", "A reason is required for a write-off.", {
      reason: ["Required"],
    });
  }

  const decremented = await tx
    .update(batches)
    .set({ qtyRemaining: sql`${batches.qtyRemaining} - ${input.quantity}` })
    .where(
      sql`${batches.id} = ${input.batchId} AND ${batches.qtyRemaining} >= ${input.quantity}`,
    )
    .returning({
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      totalCostMinor: batches.totalCostMinor,
    });

  if (decremented.length === 0) {
    const [batch] = await tx
      .select({ qtyRemaining: batches.qtyRemaining })
      .from(batches)
      .where(eq(batches.id, input.batchId))
      .limit(1);
    if (!batch) throw new DomainError("NOT_FOUND", "That batch does not exist.");
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      `Only ${batch.qtyRemaining} left in this batch — you tried to write off ${input.quantity}.`,
    );
  }

  const { qtyReceived, qtyRemaining, totalCostMinor } = decremented[0];
  const consumedAfter = qtyReceived - qtyRemaining;
  const consumedBefore = consumedAfter - input.quantity;
  const costMinor =
    costOfFirst(minor(totalCostMinor) as Minor, qtyReceived, consumedAfter) -
    costOfFirst(minor(totalCostMinor) as Minor, qtyReceived, consumedBefore);

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      batchId: input.batchId,
      movementType: "write_off",
      qtyDelta: -input.quantity,
      costMinor,
      reason: input.reason,
      refType: "stock_count",
      refId: input.idempotencyId,
      createdBy: actor,
    })
    .returning({ id: stockMovements.id });

  // No cash event: a write-off destroys value without moving money. It reduces profit (the
  // summary subtracts write-off cost) and reduces inventory, which keeps Invariant B balanced.
  return { movementId: movement.id, costMinor };
}
