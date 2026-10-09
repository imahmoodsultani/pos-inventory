/**
 * Cost allocation by prefix difference.
 *
 * A batch of N units costs T in total. We must be able to say what any contiguous run of units
 * cost, and those answers must sum back to exactly T once the batch is depleted — for ANY order
 * and ANY chunking of the draws. That is Invariant C (data-model.md §12).
 *
 * The naive approach, `Math.round(T / N)` per unit, fails this: 1000 / 3 rounds to 333 and three
 * units reconstruct 999, losing a minor unit permanently. Spreading the remainder over the first
 * few units fixes the total but makes a unit's cost depend on which draw it happened to land in,
 * so splitting one sale into two changes reported profit.
 *
 * Prefix difference solves both. Define the cost of the FIRST k units as
 *
 *     costOfFirst(k) = floor(T * k / N)
 *
 * and the cost of units (a, b] as costOfFirst(b) - costOfFirst(a). Consecutive slices telescope:
 * (0,a] + (a,b] + (b,N] = costOfFirst(N) = T, exactly, with no remainder bookkeeping. A unit's
 * cost depends only on its position in the batch, never on how the draws were grouped.
 */

import { floorDivBig, minor, type Minor } from "./money";

function assertBatchShape(totalCostMinor: Minor, qtyReceived: number): void {
  if (!Number.isInteger(qtyReceived) || qtyReceived <= 0) {
    throw new RangeError(`qtyReceived must be a positive integer, received ${qtyReceived}`);
  }
  if (!Number.isInteger(totalCostMinor)) {
    throw new TypeError(`totalCostMinor must be an integer, received ${totalCostMinor}`);
  }
}

/**
 * Total cost attributable to the first `k` units of a batch of `qtyReceived` costing
 * `totalCostMinor`. Monotonic in k; equals 0 at k=0 and exactly totalCostMinor at k=qtyReceived.
 */
export function costOfFirst(
  totalCostMinor: Minor,
  qtyReceived: number,
  k: number,
): Minor {
  assertBatchShape(totalCostMinor, qtyReceived);
  if (!Number.isInteger(k) || k < 0 || k > qtyReceived) {
    throw new RangeError(`k must be an integer in [0, ${qtyReceived}], received ${k}`);
  }
  // bigint throughout: T * k overflows Number.MAX_SAFE_INTEGER well before either operand does.
  const product = BigInt(totalCostMinor) * BigInt(k);
  return minor(Number(floorDivBig(product, BigInt(qtyReceived))));
}

/**
 * Cost of the units in the half-open range (consumedBefore, consumedAfter] — i.e. the units a
 * single draw removed from the batch, given how many had already gone.
 *
 * This is THE function the sale path uses to compute cost of goods sold. The guarded conditional
 * UPDATE returns qty_remaining before and after; convert those to consumed counts and call this.
 */
export function batchCostSlice(
  totalCostMinor: Minor,
  qtyReceived: number,
  consumedBefore: number,
  consumedAfter: number,
): Minor {
  assertBatchShape(totalCostMinor, qtyReceived);
  if (consumedAfter < consumedBefore) {
    throw new RangeError(
      `consumedAfter (${consumedAfter}) must be >= consumedBefore (${consumedBefore})`,
    );
  }
  const before = costOfFirst(totalCostMinor, qtyReceived, consumedBefore);
  const after = costOfFirst(totalCostMinor, qtyReceived, consumedAfter);
  return minor(after - before);
}

/**
 * The portion of a cost CHANGE that has already been attributed to units sold (FR-007a).
 *
 * When a landed cost arrives late, or a wrong rate is corrected, the units already sold carry a
 * frozen cost computed from the old total. Their sale lines are never rewritten, so the difference
 * has to be booked somewhere or Invariant C fails. This is that difference, written as a single
 * zero-quantity `adjustment` movement in the same transaction as the cost change.
 */
export function costCorrectionDelta(
  oldTotalCostMinor: Minor,
  newTotalCostMinor: Minor,
  qtyReceived: number,
  consumed: number,
): Minor {
  const underOld = costOfFirst(oldTotalCostMinor, qtyReceived, consumed);
  const underNew = costOfFirst(newTotalCostMinor, qtyReceived, consumed);
  return minor(underNew - underOld);
}

/**
 * Effective per-unit cost for DISPLAY, as a floor plus the remainder that the floor drops.
 *
 * There is deliberately no function here returning a single exact per-unit cost, because for most
 * batches no such integer exists: 1000 over 3 units is 333 for two of them and 334 for the third.
 * Returning `total / qty` would hand a float to the one layer that must never see one, and any
 * caller multiplying it back by a quantity would disagree with `batchCostSlice` — which is the
 * only correct source of cost of goods sold.
 *
 * `remainderMinor` is how many units cost one minor unit MORE than `unitCostFloorMinor`.
 */
export function displayUnitCost(
  totalCostMinor: Minor,
  qtyReceived: number,
): { unitCostFloorMinor: Minor; remainderMinor: number } {
  assertBatchShape(totalCostMinor, qtyReceived);
  const n = BigInt(qtyReceived);
  const t = BigInt(totalCostMinor);
  const floorPart = floorDivBig(t, n);
  return {
    unitCostFloorMinor: minor(Number(floorPart)),
    remainderMinor: Number(t - floorPart * n),
  };
}
