/**
 * `assertInvariants(db)` — called at the END of every integration test (T034).
 *
 * The point is that no test may leave the ledger in a state the system considers impossible.
 * A sale test that passes its own assertions but silently breaks the accounting identity has
 * not demonstrated a working sale.
 */

import { expect } from "vitest";
import { checkAllInvariants, computeIdentity } from "@/lib/dal/invariants";
import type { TestDb } from "./setup";

export async function assertInvariants(db: TestDb): Promise<void> {
  const results = await checkAllInvariants(db);
  const broken = results.filter((r) => !r.holds);
  if (broken.length > 0) {
    throw new Error(
      `Invariant violation:\n` + broken.map((r) => `  ✗ ${r.name} — ${r.detail}`).join("\n"),
    );
  }
}

/** Assert the SC-003 identity balances AND matches the figures a test expects. */
export async function expectIdentity(
  db: TestDb,
  expected: Partial<{
    capitalInvestedMinor: number;
    capitalRecoveredMinor: number;
    profitToDateMinor: number;
    cashOnHandMinor: number;
    inventoryAtCostMinor: number;
  }>,
): Promise<void> {
  const actual = await computeIdentity(db);
  expect(actual.lhs, `identity off by ${actual.lhs - actual.rhs}`).toBe(actual.rhs);
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key as keyof typeof actual], `${key} mismatch`).toBe(value);
  }
}
