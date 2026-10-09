import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  batchCostSlice,
  costCorrectionDelta,
  costOfFirst,
  displayUnitCost,
} from "@/lib/domain/allocation";
import { minor, sumMinor } from "@/lib/domain/money";

const totalCost = () => fc.integer({ min: 0, max: 5_000_000_00 });
const qty = () => fc.integer({ min: 1, max: 500 });

/** Split N units into arbitrary consecutive chunks — i.e. an arbitrary sequence of sales. */
const chunking = (n: number) =>
  fc
    .array(fc.integer({ min: 1, max: Math.max(1, n) }), { minLength: 1, maxLength: 50 })
    .map((raw) => {
      const chunks: number[] = [];
      let left = n;
      for (const c of raw) {
        if (left === 0) break;
        const take = Math.min(c, left);
        chunks.push(take);
        left -= take;
      }
      if (left > 0) chunks.push(left);
      return chunks;
    });

describe("Invariant C — cost allocation closure", () => {
  it("slices of a fully depleted batch sum to exactly the batch total, for any chunking", () => {
    fc.assert(
      fc.property(totalCost(), qty(), (total, n) => {
        return fc.assert(
          fc.property(chunking(n), (chunks) => {
            let consumed = 0;
            const slices = chunks.map((c) => {
              const slice = batchCostSlice(minor(total), n, consumed, consumed + c);
              consumed += c;
              return slice;
            });
            expect(consumed).toBe(n);
            // The whole point: no remainder bookkeeping, no drift, exact equality.
            expect(sumMinor(slices)).toBe(total);
          }),
          { numRuns: 25 },
        );
      }),
      { numRuns: 200 },
    );
  });

  it("costOfFirst anchors at both ends", () => {
    fc.assert(
      fc.property(totalCost(), qty(), (total, n) => {
        expect(costOfFirst(minor(total), n, 0)).toBe(0);
        expect(costOfFirst(minor(total), n, n)).toBe(total);
      }),
      { numRuns: 1000 },
    );
  });

  it("is monotonic — no unit can have a negative cost", () => {
    fc.assert(
      fc.property(totalCost(), qty(), (total, n) => {
        for (let k = 1; k <= n; k++) {
          const unit = batchCostSlice(minor(total), n, k - 1, k);
          expect(unit).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a unit's cost does not depend on how draws were grouped", () => {
    // Selling 5 then 5 must cost exactly the same as selling 10 at once, or a cashier could
    // change reported profit by splitting a basket.
    fc.assert(
      fc.property(totalCost(), fc.integer({ min: 2, max: 400 }), (total, n) => {
        const split = Math.floor(n / 2);
        const asOne = batchCostSlice(minor(total), n, 0, n);
        const asTwo = sumMinor([
          batchCostSlice(minor(total), n, 0, split),
          batchCostSlice(minor(total), n, split, n),
        ]);
        expect(asTwo).toBe(asOne);
      }),
      { numRuns: 1000 },
    );
  });

  it("beats the naive Math.round(total/n), which loses minor units", () => {
    // 1000 over 3 units: the naive approach reconstructs 999.
    const total = 1000;
    const n = 3;
    const naive = Array.from({ length: n }, () => Math.round(total / n));
    expect(naive.reduce((a, b) => a + b, 0)).toBe(999);

    const exact = Array.from({ length: n }, (_, k) =>
      batchCostSlice(minor(total), n, k, k + 1),
    );
    expect(sumMinor(exact)).toBe(1000);
    expect(exact).toEqual([333, 333, 334]);
  });
});

describe("costCorrectionDelta — FR-007a", () => {
  it("is zero when nothing has been sold yet", () => {
    fc.assert(
      fc.property(totalCost(), totalCost(), qty(), (oldT, newT, n) => {
        expect(costCorrectionDelta(minor(oldT), minor(newT), n, 0)).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it("is the whole difference once the batch is fully consumed", () => {
    fc.assert(
      fc.property(totalCost(), totalCost(), qty(), (oldT, newT, n) => {
        expect(costCorrectionDelta(minor(oldT), minor(newT), n, n)).toBe(newT - oldT);
      }),
      { numRuns: 500 },
    );
  });

  it("restores closure: sold-unit costs + delta + remaining-unit costs === new total", () => {
    // This is exactly why the adjustment row exists. Sale lines keep their frozen cost, so
    // without the delta the batch's movements would no longer sum to total_cost_minor.
    fc.assert(
      fc.property(
        totalCost(),
        totalCost(),
        qty(),
        fc.nat(),
        (oldT, newT, n, rawConsumed) => {
          const consumed = rawConsumed % (n + 1);
          const frozenSoldCost = costOfFirst(minor(oldT), n, consumed);
          const delta = costCorrectionDelta(minor(oldT), minor(newT), n, consumed);
          const remaining = batchCostSlice(minor(newT), n, consumed, n);
          expect(sumMinor([frozenSoldCost, delta, remaining])).toBe(newT);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("displayUnitCost", () => {
  it("never returns a float and reconstructs the total", () => {
    fc.assert(
      fc.property(totalCost(), qty(), (total, n) => {
        const { unitCostFloorMinor, remainderMinor } = displayUnitCost(minor(total), n);
        expect(Number.isInteger(unitCostFloorMinor)).toBe(true);
        expect(Number.isInteger(remainderMinor)).toBe(true);
        expect(remainderMinor).toBeGreaterThanOrEqual(0);
        expect(remainderMinor).toBeLessThan(n);
        expect(unitCostFloorMinor * n + remainderMinor).toBe(total);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("input guards", () => {
  it("rejects nonsensical batches rather than returning a wrong number", () => {
    expect(() => costOfFirst(minor(100), 0, 0)).toThrow(RangeError);
    expect(() => costOfFirst(minor(100), 10, 11)).toThrow(RangeError);
    expect(() => costOfFirst(minor(100), 10, -1)).toThrow(RangeError);
    expect(() => batchCostSlice(minor(100), 10, 5, 4)).toThrow(RangeError);
  });
});
