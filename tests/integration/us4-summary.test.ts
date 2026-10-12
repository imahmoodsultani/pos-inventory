import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { recordCapitalInjection, recordWithdrawal } from "@/lib/services/capital";
import { addLandedCost, receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";
import { recordWriteOff } from "@/lib/services/stock-corrections";

import { ACTOR, seedCatalogue } from "./fixtures";
import { assertInvariants } from "./invariants";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

/**
 * Tests computeSummary, the executor-taking query, rather than the authenticated wrapper.
 *
 * No session mock: the wrapper is three lines (requireOwner then delegate), and the role
 * boundary is covered where it actually matters — us2-salesperson-visibility and the E2E suite.
 * Mocking auth here would have tested the mock.
 */
import { computeSummary } from "@/lib/dal/summary-query";

const getBusinessSummary = (params?: { from?: Date | null; to?: Date | null }) =>
  computeSummary(db, params);

let db: TestDb;
let cat: Awaited<ReturnType<typeof seedCatalogue>>;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});
beforeEach(async () => {
  await truncateAll();
  cat = await seedCatalogue(db);
});

const at = (iso: string) => new Date(iso);

/**
 * A scripted history with every figure worked out by hand, so the test asserts what the business
 * SHOULD say rather than what the code happens to compute.
 *
 *   1. inject 100,000                       cash 100,000
 *   2. buy 100 @ 20,000 total               cash  80,000   inventory 20,000
 *   3. sell 40 @ 300 each  = 12,000         cash  92,000   cost 8,000   profit 4,000
 *                                                          inventory 12,000
 *   4. write off 10 units  (cost 2,000)     profit 2,000   inventory 10,000
 *   5. add 1,000 landed cost                cash  91,000   total 21,000
 *        adjustment on the 50 consumed:
 *          floor(21000*50/100) - floor(20000*50/100) = 10500 - 10000 = 500
 *        profit 2,000 - 500 = 1,500
 *        inventory = 21,000 - floor(21,000*50/100) = 10,500
 *   6. withdraw 5,000                       cash 86,000    recovered 5,000
 *
 *   identity: 100,000 - 5,000 + 1,500 = 96,500   and   86,000 + 10,500 = 96,500 ✓
 */
async function scriptedHistory() {
  await db.transaction((tx) =>
    recordCapitalInjection(tx as Tx, ACTOR, {
      amountMinor: 100_000,
      occurredAt: at("2026-01-05T10:00:00Z"),
    }),
  );

  const batch = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qtyReceived: 100,
      goodsCostMinor: 20_000,
      landedCostMinor: 0,
      receivedAt: at("2026-01-10T10:00:00Z"),
      funding: { newCapitalMinor: 20_000, reinvestedMinor: 0 },
    }),
  );

  await db.transaction((tx) =>
    recordSale(tx as Tx, ACTOR, {
      paymentMethod: "cash",
      lines: [{ batchId: batch.batchId, quantity: 40, unitPriceMinor: 300 }],
    }),
  );
  // sold_at defaults to now(); pin it so the date-range test is deterministic.
  await db.execute(sql`UPDATE sales SET sold_at = '2026-02-15T10:00:00Z'`);

  await db.transaction((tx) =>
    recordWriteOff(tx as Tx, ACTOR, {
      batchId: batch.batchId,
      quantity: 10,
      reason: "Water damage",
      idempotencyId: 1,
    }),
  );

  await db.transaction((tx) =>
    addLandedCost(tx as Tx, ACTOR, {
      batchId: batch.batchId,
      additionalCostMinor: 1_000,
      idempotencyId: 2,
      reason: "Freight invoice",
    }),
  );

  await db.transaction((tx) =>
    recordWithdrawal(tx as Tx, ACTOR, {
      amountMinor: 5_000,
      occurredAt: at("2026-03-01T10:00:00Z"),
    }),
  );

  return batch;
}

describe("US4 — the business summary (FR-033 … FR-035)", () => {
  it("every figure matches the hand-computed expectation", async () => {
    await scriptedHistory();
    const summary = await getBusinessSummary();

    expect(summary.capitalInvestedMinor).toBe(100_000);
    expect(summary.capitalRecoveredMinor).toBe(5_000);
    expect(summary.cashOnHandMinor).toBe(86_000);
    expect(summary.inventoryAtCostMinor).toBe(10_500);
    expect(summary.profitToDateMinor).toBe(1_500);

    // SC-003, exact to the minor unit.
    expect(summary.identityHolds).toBe(true);
    expect(summary.identityDifferenceMinor).toBe(0);
    await assertInvariants(db);
  });

  it("reports identityHolds rather than hiding a broken ledger", async () => {
    await scriptedHistory();

    // Corrupt the ledger behind the service's back — batches carries only a DELETE trigger, so
    // a direct UPDATE is possible and is exactly the kind of drift the flag exists to surface.
    await db.execute(sql`UPDATE batches SET qty_remaining = qty_remaining + 7`);

    const summary = await getBusinessSummary();
    expect(
      summary.identityHolds,
      "the summary reported a healthy identity against a corrupted ledger",
    ).toBe(false);
    expect(summary.identityDifferenceMinor).not.toBe(0);
  });

  it("a date range re-slices ACTIVITY but leaves POSITION figures current (FR-034)", async () => {
    await scriptedHistory();

    const all = await getBusinessSummary();
    // January only: the injection landed, but the sale (February) and withdrawal (March) did not.
    const january = await getBusinessSummary({
      from: at("2026-01-01T00:00:00Z"),
      to: at("2026-02-01T00:00:00Z"),
    });

    // ACTIVITY is re-sliced.
    expect(january.capitalInvestedMinor).toBe(100_000);
    expect(january.capitalRecoveredMinor).toBe(0);

    /**
     * POSITION is NOT. There is no such thing as "cash on hand during January" — a balance
     * exists at an instant, not over a period. Recomputing it from the window would report
     * January's net cash MOVEMENT under the label "cash on hand", which is a different number
     * wearing the same name.
     */
    expect(january.cashOnHandMinor).toBe(all.cashOnHandMinor);
    expect(january.inventoryAtCostMinor).toBe(all.inventoryAtCostMinor);

    // February holds the sale's profit but not the injection.
    const february = await getBusinessSummary({
      from: at("2026-02-01T00:00:00Z"),
      to: at("2026-03-01T00:00:00Z"),
    });
    expect(february.capitalInvestedMinor).toBe(0);
    expect(february.profitToDateMinor).toBe(4_000);
  });

  it("does not claim the identity holds for a ranged view", async () => {
    await scriptedHistory();

    const january = await getBusinessSummary({
      from: at("2026-01-01T00:00:00Z"),
      to: at("2026-02-01T00:00:00Z"),
    });

    // Ranged activity against current position cannot balance, so asserting it there would fire
    // a false alarm on every filtered view. The flag is only meaningful over all time.
    expect(january.identityDifferenceMinor).toBe(0);
    expect(january.range.from).not.toBeNull();
  });

  it("is zero everywhere on an empty business, and still balances", async () => {
    const summary = await getBusinessSummary();
    expect(summary).toMatchObject({
      profitToDateMinor: 0,
      capitalInvestedMinor: 0,
      capitalRecoveredMinor: 0,
      cashOnHandMinor: 0,
      inventoryAtCostMinor: 0,
      identityHolds: true,
    });
  });
});
