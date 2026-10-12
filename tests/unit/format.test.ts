import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatMinor, parseMinor } from "@/lib/format";

describe("parseMinor", () => {
  it("does not go through floating point", () => {
    // The motivating case: 19.99 * 100 === 1998.9999999999998 in binary floating point.
    expect(19.99 * 100).not.toBe(1999);
    expect(parseMinor("19.99")).toBe(1999);
    expect(parseMinor("0.07")).toBe(7);
    expect(parseMinor("1234.5")).toBe(123450);
    expect(parseMinor("1,234.56")).toBe(123456);
  });

  it("round-trips with formatMinor", () => {
    fc.assert(
      fc.property(fc.integer({ min: -(10 ** 10), max: 10 ** 10 }), (amount) => {
        expect(parseMinor(formatMinor(amount))).toBe(amount);
      }),
      { numRuns: 2000 },
    );
  });

  it("returns null for junk rather than guessing", () => {
    for (const bad of ["", "   ", "abc", "1.234", "1.2.3", "--5", "1e3"]) {
      expect(parseMinor(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("handles negatives and zero", () => {
    expect(parseMinor("-0.05")).toBe(-5);
    expect(parseMinor("0")).toBe(0);
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(-5)).toBe("-0.05");
  });
});
