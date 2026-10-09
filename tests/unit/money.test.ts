import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addMinor,
  floorDiv,
  floorDivBig,
  minor,
  minorFromBigInt,
  mulMinor,
  subMinor,
  sumMinor,
} from "@/lib/domain/money";

const safeInt = () => fc.integer({ min: -(2 ** 40), max: 2 ** 40 });
const nonZeroInt = () =>
  fc.integer({ min: -(2 ** 20), max: 2 ** 20 }).filter((n) => n !== 0);

describe("floorDiv", () => {
  it("agrees with mathematical floor, including where Math.trunc would not", () => {
    fc.assert(
      fc.property(safeInt(), nonZeroInt(), (a, b) => {
        // Compared numerically, not with Object.is: Math.floor(0 / -5) is -0, and floorDiv
        // deliberately normalises that to +0 (see the negative-zero test below).
        expect(floorDiv(a, b)).toEqual(Math.floor(a / b) + 0);
      }),
      { numRuns: 2000 },
    );
  });

  it("never returns negative zero", () => {
    // -0 compares equal to 0 but serialises as "-0" through JSON and formats as "-0.00" in a
    // currency formatter. A ledger that can print a negative zero invites a support ticket.
    expect(Object.is(floorDiv(0, -5), -0)).toBe(false);
    expect(Object.is(Math.floor(0 / -5), -0)).toBe(true);
    fc.assert(
      fc.property(safeInt(), nonZeroInt(), (a, b) => {
        expect(Object.is(floorDiv(a, b), -0)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it("rounds negatives DOWN, where Math.trunc rounds toward zero", () => {
    // This is the concrete divergence the single shared floorDiv exists to prevent.
    // A return or reversal divided with Math.trunc makes totals drift upward.
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(Math.trunc(-7 / 2)).toBe(-3);
    expect(floorDiv(-1, 3)).toBe(-1);
    expect(floorDiv(7, -2)).toBe(-4);
    expect(floorDiv(-7, -2)).toBe(3);
  });

  it("satisfies the division identity a === b*q + r with 0 <= |r| < |b| and r signed like b", () => {
    fc.assert(
      fc.property(safeInt(), nonZeroInt(), (a, b) => {
        const q = floorDivBig(BigInt(a), BigInt(b));
        const r = BigInt(a) - BigInt(b) * q;
        expect(Number(BigInt(b) * q + r)).toBe(a);
        expect(Math.abs(Number(r))).toBeLessThan(Math.abs(b));
        if (r !== 0n) expect(r < 0n).toBe(b < 0);
      }),
      { numRuns: 2000 },
    );
  });

  it("throws on division by zero rather than returning Infinity", () => {
    expect(() => floorDiv(1, 0)).toThrow(RangeError);
  });
});

describe("Minor", () => {
  it("rejects floats", () => {
    expect(() => minor(1.5)).toThrow(TypeError);
    expect(() => minor(0.1 + 0.2)).toThrow(TypeError);
  });

  it("rejects magnitudes that cannot be represented exactly", () => {
    expect(() => minor(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(() => minorFromBigInt(2n ** 60n)).toThrow(RangeError);
  });

  it("round-trips through bigint", () => {
    fc.assert(
      fc.property(safeInt(), (n) => {
        expect(minorFromBigInt(BigInt(n))).toBe(n);
      }),
    );
  });
});

describe("arithmetic", () => {
  it("is exact and never produces a float", () => {
    fc.assert(
      fc.property(safeInt(), safeInt(), (a, b) => {
        const sum = addMinor(minor(a), minor(b));
        expect(Number.isInteger(sum)).toBe(true);
        expect(sum).toBe(a + b);
        expect(subMinor(minor(a), minor(b))).toBe(a - b);
      }),
      { numRuns: 1000 },
    );
  });

  it("sums a list exactly regardless of order", () => {
    fc.assert(
      fc.property(fc.array(safeInt(), { maxLength: 60 }), (xs) => {
        const forward = sumMinor(xs.map(minor));
        const reversed = sumMinor([...xs].reverse().map(minor));
        expect(forward).toBe(reversed);
      }),
    );
  });

  it("multiplies by an integer scalar only", () => {
    expect(mulMinor(minor(250), 4)).toBe(1000);
    expect(() => mulMinor(minor(250), 1.5)).toThrow(TypeError);
  });
});
