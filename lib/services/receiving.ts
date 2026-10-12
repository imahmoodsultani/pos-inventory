import "server-only";

/**
 * Receiving: batches, landed costs, cost corrections, vendor returns (T045-T047).
 *
 * This is the anchor of every later figure. A batch records ONE receipt of ONE product from ONE
 * vendor at ONE quality at ONE rate, and those facts stay attached to those specific units for
 * the rest of their life in the business. Per-unit cost is never stored — it is derived by
 * prefix-difference allocation so the parts always sum back to the whole exactly.
 *
 * Every function here takes a transaction handle. They are composed by the action wrapper, which
 * owns the transaction and the idempotency claim, so a partial receipt can never commit.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  batches,
  cashEvents,
  fundingAllocations,
  stockMovements,
} from "@/lib/db/schema";
import { costCorrectionDelta, costOfFirst } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { assertCashAvailable, getCashOnHandMinor as cashOnHand } from "@/lib/services/capital";
import { DomainError } from "@/lib/services/domain-error";
import { messages } from "@/lib/types/action-result";

type Actor = string;

/**
 * Re-exported so callers have ONE cash balance function, not two that can drift apart.
 * The implementation lives in capital.ts alongside the guard that uses it.
 */
export const getCashOnHandMinor = cashOnHand;

/**
 * Retained sale proceeds — the FR-029a reinvestment cap (data-model.md §9).
 *
 * Proceeds, NOT profit: recovering the cost of goods and putting it straight back into stock is
 * reinvesting revenue, which is how this business actually operates. Subtracting prior
 * `reinvested_minor` stops the same proceeds being reinvested twice; subtracting withdrawals
 * stops money being both taken out and redeployed.
 */
export async function getRetainedSaleProceedsMinor(tx: Tx): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT
        COALESCE((SELECT SUM(amount_minor) FROM cash_events
                   WHERE direction = 'in' AND source_type = 'sale'), 0)
      - COALESCE((SELECT SUM(amount_minor) FROM cash_events
                   WHERE direction = 'out' AND source_type IN ('sale_refund', 'withdrawal')), 0)
      - COALESCE((SELECT SUM(reinvested_minor) FROM funding_allocations), 0)
      AS retained
  `);
  return Number(firstRow<{ retained: number }>(rows)?.retained ?? 0);
}

export type ReceiveStockInput = {
  productId: number;
  vendorId: number;
  gradeId: number;
  qtyReceived: number;
  goodsCostMinor: number;
  landedCostMinor: number;
  receivedAt: Date;
  reference?: string;
  funding: { newCapitalMinor: number; reinvestedMinor: number };
};

export type ReceiveStockResult = {
  batchId: number;
  totalCostMinor: number;
  qtyReceived: number;
};

/**
 * Record a receipt. The six steps run in the order given by contracts/server-actions.md, and the
 * order matters: funding is validated BEFORE cash is spent, so a mismatched split never leaves a
 * cash event behind.
 */
export async function receiveStock(
  tx: Tx,
  actor: Actor,
  input: ReceiveStockInput,
): Promise<ReceiveStockResult> {
  const totalCostMinor = input.goodsCostMinor + input.landedCostMinor;
  const { newCapitalMinor, reinvestedMinor } = input.funding;

  // 1. Funding must exactly fund the purchase (FR-026). Checked before anything is written.
  const fundingTotal = newCapitalMinor + reinvestedMinor;
  if (fundingTotal !== totalCostMinor) {
    throw new DomainError(
      "FUNDING_MISMATCH",
      messages.fundingMismatch(fundingTotal - totalCostMinor),
    );
  }

  // 2. Reinvestment cannot exceed what trading has actually produced and retained (FR-029a).
  if (reinvestedMinor > 0) {
    const retained = await getRetainedSaleProceedsMinor(tx);
    if (reinvestedMinor > retained) {
      throw new DomainError(
        "VALIDATION",
        `You can reinvest at most ${retained} (minor units) of sale proceeds; ` +
          `${reinvestedMinor} was entered. The rest must be recorded as new capital.`,
        { reinvestedMinor: ["Exceeds retained sale proceeds"] },
      );
    }
  }

  // 3. The batch itself. total_cost_minor is GENERATED, so it is never inserted.
  const [batch] = await tx
    .insert(batches)
    .values({
      productId: input.productId,
      vendorId: input.vendorId,
      gradeId: input.gradeId,
      receivedAt: input.receivedAt,
      reference: input.reference,
      qtyReceived: input.qtyReceived,
      qtyRemaining: input.qtyReceived,
      goodsCostMinor: input.goodsCostMinor,
      landedCostMinor: input.landedCostMinor,
      createdBy: actor,
    })
    .returning({ id: batches.id, totalCostMinor: batches.totalCostMinor });

  // 4. The ledger entry. Invariant A reconstructs qty_remaining from these.
  await tx.insert(stockMovements).values({
    batchId: batch.id,
    movementType: "receipt",
    qtyDelta: input.qtyReceived,
    costMinor: batch.totalCostMinor,
    refType: "batch",
    refId: batch.id,
    createdBy: actor,
  });

  // 5. The funding split — descriptive only; it feeds no capital total (FR-026a).
  await tx.insert(fundingAllocations).values({
    batchId: batch.id,
    newCapitalMinor,
    reinvestedMinor,
    createdBy: actor,
  });

  // 6. Pay for it. Refuse rather than let cash go negative (FR-031).
  await spendCash(tx, actor, {
    amountMinor: batch.totalCostMinor,
    sourceType: "purchase_payment",
    sourceId: batch.id,
    occurredAt: input.receivedAt,
  });

  return {
    batchId: batch.id,
    totalCostMinor: batch.totalCostMinor,
    qtyReceived: input.qtyReceived,
  };
}

/** Write an outgoing cash event, refusing if it would drive the balance below zero. */
async function spendCash(
  tx: Tx,
  actor: Actor,
  params: {
    amountMinor: number;
    sourceType: "purchase_payment" | "withdrawal" | "sale_refund" | "cost_adjustment";
    sourceId: number;
    occurredAt: Date;
  },
): Promise<void> {
  // Shared with withdrawals (T076). Takes a transaction-scoped advisory lock so two concurrent
  // debits cannot both read the same balance and both pass — the read-then-write race.
  await assertCashAvailable(tx, params.amountMinor);
  await tx.insert(cashEvents).values({
    direction: "out",
    amountMinor: params.amountMinor,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    occurredAt: params.occurredAt,
    createdBy: actor,
  });
}

type BatchRow = {
  id: number;
  qtyReceived: number;
  qtyRemaining: number;
  goodsCostMinor: number;
  landedCostMinor: number;
  totalCostMinor: number;
};

async function loadBatch(tx: Tx, batchId: number): Promise<BatchRow> {
  const [row] = await tx
    .select({
      id: batches.id,
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      goodsCostMinor: batches.goodsCostMinor,
      landedCostMinor: batches.landedCostMinor,
      totalCostMinor: batches.totalCostMinor,
    })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "That batch does not exist.");
  return row;
}

export type CostChangeResult = {
  batchId: number;
  totalCostMinor: number;
  adjustmentMinor: number;
  adjustmentMovementId: number | null;
};

/**
 * Change a batch's cost, correctly (FR-007, FR-007a).
 *
 * ⚠️ THE TRAP. Changing total_cost_minor has two consequences that are easy to miss and silent
 * when missed:
 *
 *   1. `funding_allocations` no longer sums to the total, breaking FR-026. Re-balanced here, in
 *      the same transaction. (This is also why funding_allocations carries only a DELETE
 *      trigger — a BEFORE UPDATE trigger would make every call throw.)
 *
 *   2. Units already sold carry a cost computed from the OLD total, and their sale lines are
 *      never rewritten. Without booking the difference, Invariant C stops closing. A single
 *      zero-quantity `adjustment` movement carries exactly the portion of the change already
 *      attributed to sold units.
 */
async function applyCostChange(
  tx: Tx,
  actor: Actor,
  params: {
    batchId: number;
    idempotencyId: number;
    newGoodsCostMinor: number;
    newLandedCostMinor: number;
    reason: string;
    funding?: { newCapitalMinor: number; reinvestedMinor: number };
  },
): Promise<CostChangeResult> {
  const batch = await loadBatch(tx, params.batchId);
  const oldTotal = batch.totalCostMinor;
  const newTotal = params.newGoodsCostMinor + params.newLandedCostMinor;
  const consumed = batch.qtyReceived - batch.qtyRemaining;

  if (newTotal === oldTotal) {
    throw new DomainError("CONFLICT", "That would leave the batch cost unchanged.");
  }

  // The amount of the change already attributed to units that have been sold.
  const delta = costCorrectionDelta(
    minor(oldTotal) as Minor,
    minor(newTotal) as Minor,
    batch.qtyReceived,
    consumed,
  );

  await tx
    .update(batches)
    .set({
      goodsCostMinor: params.newGoodsCostMinor,
      landedCostMinor: params.newLandedCostMinor,
      isCostCorrected: true,
    })
    .where(eq(batches.id, params.batchId));

  // Re-balance funding, or FR-026 breaks silently.
  const difference = newTotal - oldTotal;
  if (params.funding) {
    const fundingTotal = params.funding.newCapitalMinor + params.funding.reinvestedMinor;
    if (fundingTotal !== newTotal) {
      throw new DomainError(
        "FUNDING_MISMATCH",
        messages.fundingMismatch(fundingTotal - newTotal),
      );
    }
    await tx
      .update(fundingAllocations)
      .set({
        newCapitalMinor: params.funding.newCapitalMinor,
        reinvestedMinor: params.funding.reinvestedMinor,
      })
      .where(eq(fundingAllocations.batchId, params.batchId));
  } else {
    // Default: the extra cost came out of pocket as new capital.
    await tx
      .update(fundingAllocations)
      .set({ newCapitalMinor: sql`${fundingAllocations.newCapitalMinor} + ${difference}` })
      .where(eq(fundingAllocations.batchId, params.batchId));
  }

  let adjustmentMovementId: number | null = null;
  if (delta !== 0) {
    // ref_type = 'cost_correction' with ref_id = the idempotency row id. Reusing
    // ('batch', batchId) would collide with this batch's own receipt row on the unique index;
    // keying on the batch alone would collide on a SECOND correction, which is legitimate.
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        batchId: params.batchId,
        movementType: "adjustment",
        qtyDelta: 0,
        costMinor: delta,
        reason: params.reason,
        refType: "cost_correction",
        refId: params.idempotencyId,
        createdBy: actor,
      })
      .returning({ id: stockMovements.id });
    adjustmentMovementId = movement.id;
  }

  // Pay the difference (or receive it back, if the correction reduced the cost).
  if (difference > 0) {
    // 'cost_adjustment', NOT 'purchase_payment'. cash_events is unique on
    // (source_type, source_id) to guarantee one cash effect per business event, and batch ids
    // and idempotency ids are separate sequences sharing that namespace — a landed cost on
    // batch 1 collided with the original payment for batch 1. A late cost IS a distinct
    // business event, so it gets its own source_type rather than a disambiguating hack.
    await spendCash(tx, actor, {
      amountMinor: difference,
      sourceType: "cost_adjustment",
      sourceId: params.idempotencyId,
      occurredAt: new Date(),
    });
  } else if (difference < 0) {
    // A correction that REDUCED the cost returns money. Same source_type, opposite direction —
    // `direction` is what distinguishes them, not a second type name.
    await tx.insert(cashEvents).values({
      direction: "in",
      amountMinor: -difference,
      sourceType: "cost_adjustment",
      sourceId: params.idempotencyId,
      occurredAt: new Date(),
      createdBy: actor,
    });
  }

  return {
    batchId: params.batchId,
    totalCostMinor: newTotal,
    adjustmentMinor: delta,
    adjustmentMovementId,
  };
}

export async function addLandedCost(
  tx: Tx,
  actor: Actor,
  input: {
    batchId: number;
    additionalCostMinor: number;
    idempotencyId: number;
    reason?: string;
    funding?: { newCapitalMinor: number; reinvestedMinor: number };
  },
): Promise<CostChangeResult> {
  const batch = await loadBatch(tx, input.batchId);
  return applyCostChange(tx, actor, {
    batchId: input.batchId,
    idempotencyId: input.idempotencyId,
    newGoodsCostMinor: batch.goodsCostMinor,
    newLandedCostMinor: batch.landedCostMinor + input.additionalCostMinor,
    reason: input.reason ?? "Landed cost added after receipt",
    funding: input.funding,
  });
}

export async function correctBatchCost(
  tx: Tx,
  actor: Actor,
  input: {
    batchId: number;
    newGoodsCostMinor: number;
    idempotencyId: number;
    reason: string;
    funding?: { newCapitalMinor: number; reinvestedMinor: number };
  },
): Promise<CostChangeResult> {
  const batch = await loadBatch(tx, input.batchId);
  return applyCostChange(tx, actor, {
    batchId: input.batchId,
    idempotencyId: input.idempotencyId,
    newGoodsCostMinor: input.newGoodsCostMinor,
    newLandedCostMinor: batch.landedCostMinor,
    reason: input.reason,
    funding: input.funding,
  });
}

/**
 * Return units to the vendor (FR-023, FR-023a).
 *
 * The refund amount is DERIVED from the batch, never accepted from the caller — the input shape
 * has no field for it. That makes partial credits and restocking fees unrepresentable by
 * construction, which is what guarantees a vendor return can never move profit.
 */
export async function returnToVendor(
  tx: Tx,
  actor: Actor,
  input: { batchId: number; quantity: number; reason: string; idempotencyId: number },
): Promise<{ movementId: number; refundMinor: number }> {
  // Guarded conditional UPDATE — the same mechanism the sale path uses. rowCount === 0 means
  // someone else took the stock first.
  const decremented = await tx
    .update(batches)
    .set({ qtyRemaining: sql`${batches.qtyRemaining} - ${input.quantity}` })
    .where(
      and(
        eq(batches.id, input.batchId),
        sql`${batches.qtyRemaining} >= ${input.quantity}`,
      ),
    )
    .returning({
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      totalCostMinor: batches.totalCostMinor,
    });

  if (decremented.length === 0) {
    const batch = await loadBatch(tx, input.batchId);
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      messages.insufficientStock(batch.qtyRemaining, input.quantity),
    );
  }

  const { qtyReceived, qtyRemaining, totalCostMinor } = decremented[0];
  const consumedAfter = qtyReceived - qtyRemaining;
  const consumedBefore = consumedAfter - input.quantity;

  // Exactly the effective cost of the units leaving, by the same allocation as a sale.
  const refundMinor =
    costOfFirst(minor(totalCostMinor) as Minor, qtyReceived, consumedAfter) -
    costOfFirst(minor(totalCostMinor) as Minor, qtyReceived, consumedBefore);

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      batchId: input.batchId,
      movementType: "vendor_return",
      qtyDelta: -input.quantity,
      costMinor: refundMinor,
      reason: input.reason,
      refType: "vendor_return",
      refId: input.idempotencyId,
      createdBy: actor,
    })
    .returning({ id: stockMovements.id });

  await tx.insert(cashEvents).values({
    direction: "in",
    amountMinor: refundMinor,
    sourceType: "vendor_refund",
    sourceId: input.idempotencyId,
    occurredAt: new Date(),
    createdBy: actor,
  });

  return { movementId: movement.id, refundMinor };
}

function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  return (result as { rows?: T[] }).rows?.[0];
}
