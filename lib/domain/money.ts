/**
 * Money. BIGINT minor units in Postgres, a branded integer in TypeScript.
 *
 * There are no floats anywhere in this module, and nothing exported from it can produce one.
 * Every arithmetic helper takes integers and returns integers, and throws rather than silently
 * returning something unrepresentable.
 *
 * Internal arithmetic is done in `bigint`, not `number`. `costOfFirst` in ./allocation.ts
 * multiplies a total by a quantity before dividing; with a total in minor units that product
 * can exceed Number.MAX_SAFE_INTEGER long before either operand looks suspicious, and the
 * failure mode is a silently wrong unit cost rather than an exception. Converting at the
 * boundary costs nothing measurable and removes the whole class of bug.
 */

declare const MINOR: unique symbol;

/** An integer count of minor units (e.g. 1250 = 12.50 in a 2-decimal currency). */
export type Minor = number & { readonly [MINOR]: true };

export const ZERO: Minor = 0 as Minor;

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${label} exceeds Number.MAX_SAFE_INTEGER (${value}); it cannot be represented exactly`,
    );
  }
}

/** Narrow a plain number to Minor, rejecting floats and unsafe magnitudes. */
export function minor(value: number): Minor {
  assertSafeInteger(value, "money value");
  return value as Minor;
}

/** Convert a BIGINT read from Postgres. Throws rather than losing precision silently. */
export function minorFromBigInt(value: bigint): Minor {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `BIGINT ${value} cannot be represented exactly as a JavaScript number`,
    );
  }
  return Number(value) as Minor;
}

export function minorToBigInt(value: Minor): bigint {
  return BigInt(value);
}

/**
 * Mathematical floor division, in bigint.
 *
 * bigint `/` truncates toward zero, so -7n / 2n is -3n where the floor is -4n. Every division
 * in this codebase goes through one of the two floorDiv functions precisely so that negative
 * amounts (returns, reversals, write-offs) round the same direction as positive ones. Mixing
 * Math.floor and Math.trunc is how allocation totals stop summing to the original.
 */
export function floorDivBig(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("division by zero");
  const q = a / b;
  const hasRemainder = a % b !== 0n;
  const oppositeSigns = a < 0n !== b < 0n;
  return hasRemainder && oppositeSigns ? q - 1n : q;
}

/** Mathematical floor division on safe integers. The single shared floorDiv (CLAUDE.md § Money). */
export function floorDiv(a: number, b: number): number {
  assertSafeInteger(a, "dividend");
  assertSafeInteger(b, "divisor");
  return Number(floorDivBig(BigInt(a), BigInt(b)));
}

export function addMinor(a: Minor, b: Minor): Minor {
  return minor(Number(BigInt(a) + BigInt(b)));
}

export function subMinor(a: Minor, b: Minor): Minor {
  return minor(Number(BigInt(a) - BigInt(b)));
}

/** Multiply by an integer scalar (a quantity), never by a rate. */
export function mulMinor(amount: Minor, factor: number): Minor {
  assertSafeInteger(factor, "factor");
  return minor(Number(BigInt(amount) * BigInt(factor)));
}

export function negateMinor(a: Minor): Minor {
  return minor(-a);
}

export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0n;
  for (const v of values) total += BigInt(v);
  return minor(Number(total));
}

export function isNegative(a: Minor): boolean {
  return a < 0;
}
