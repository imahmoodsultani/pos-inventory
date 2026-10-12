/**
 * Display formatting for money held as BIGINT minor units.
 *
 * Parsing and formatting live here, together, so the two can never disagree about how many
 * decimal places a minor unit represents.
 */

/** Minor units per major unit. Two decimal places; single-currency by design (Assumptions). */
export const MINOR_PER_MAJOR = 100;

export function formatMinor(amountMinor: number): string {
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / MINOR_PER_MAJOR);
  const fraction = abs % MINOR_PER_MAJOR;
  const body = `${major.toLocaleString()}.${String(fraction).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * Parse a typed amount into integer minor units.
 *
 * Returns null rather than NaN or a rounded guess, so a caller must decide what to do about bad
 * input. Multiplication is done on the digit string, NOT as `value * 100`: in binary floating
 * point `19.99 * 100` is 1998.9999999999998, and `Math.round` on that hides a real class of
 * error behind an answer that is usually right.
 */
export function parseMinor(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (trimmed === "") return null;

  const match = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fractionRaw] = match;
  if (whole === "" && (fractionRaw ?? "") === "") return null;

  const fraction = (fractionRaw ?? "").padEnd(2, "0");
  const minorUnits = Number(`${whole || "0"}${fraction}`);
  if (!Number.isSafeInteger(minorUnits)) return null;

  return sign === "-" ? -minorUnits : minorUnits;
}
