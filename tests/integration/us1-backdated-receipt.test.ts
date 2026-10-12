import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { computeSummary } from "@/lib/dal/summary-query";
import { recordCapitalInjection } from "@/lib/services/capital";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

import { ACTOR, seedCatalogue } from "./fixtures";
import { assertInvariants } from "./invariants";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

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
  await db.transaction((tx) =>
    recordCapitalInjection(tx as Tx, ACTOR, {
      amountMinor: 100_000,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    }),
  );
});

const at = (iso: string) => new Date(iso);

/**
 * T039b — backdated receipts (edge case: stock that arrived before the system went live, or an
 * invoice entered late).
 *
 * The spec permits backdating, so the REPORTING consequence has to be pinned down rather than
 * discovered later: a receipt dated March but entered in May must be attributed to March in a
 * date-filtered view. Otherwise an owner reconciling their March figures against paper records
 * finds a discrepancy they cannot explain, and the system looks wrong even though the stock is
 * correct.
 */
describe("US1 — backdated receipts and their reporting consequence", () => {
  it("accepts a receipt dated earlier than the most recent sale", async () => {
    // Sell from a batch received in April...
    const april = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1_000,
        landedCostMinor: 0,
        receivedAt: at("2026-04-01T10:00:00Z"),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
      }),
    );
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: april.batchId, quantity: 5, unitPriceMinor: 200 }],
      }),
    );

    // ...then enter a delivery that actually arrived in FEBRUARY, before that sale.
    const february = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorB,
        gradeId: cat.gradeB,
        qtyReceived: 20,
        goodsCostMinor: 3_000,
        landedCostMinor: 0,
        receivedAt: at("2026-02-10T10:00:00Z"),
        reference: "Invoice found in a drawer",
        funding: { newCapitalMinor: 3_000, reinvestedMinor: 0 },
      }),
    );

    expect(february.batchId).toBeGreaterThan(april.batchId);
    // Accepted, not rejected — the batch is real stock regardless of when it was keyed in.
    await assertInvariants(db);
  });

  it("attributes the receipt to its received_at period, not its entry time", async () => {
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 20,
        goodsCostMinor: 3_000,
        landedCostMinor: 0,
        receivedAt: at("2026-02-10T10:00:00Z"),
        funding: { newCapitalMinor: 3_000, reinvestedMinor: 0 },
      }),
    );

    const rows = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE received_at >= '2026-02-01' AND received_at < '2026-03-01'
        ) AS in_february,
        COUNT(*) FILTER (
          WHERE created_at >= '2026-02-01' AND created_at < '2026-03-01'
        ) AS created_in_february
      FROM batches
    `);
    const row = (
      Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
    )[0] as { in_february: string; created_in_february: string };

    // received_at says February (what the owner means); created_at says today (when it was
    // keyed in). Any period report must read received_at, or a late entry lands in the wrong
    // month and the owner cannot reconcile against their paper invoices.
    expect(Number(row.in_february)).toBe(1);
    expect(Number(row.created_in_february)).toBe(0);
  });

  it("the cash and inventory position reflects it immediately, whatever its date", async () => {
    const before = await computeSummary(db);

    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 20,
        goodsCostMinor: 3_000,
        landedCostMinor: 0,
        receivedAt: at("2026-02-10T10:00:00Z"),
        funding: { newCapitalMinor: 3_000, reinvestedMinor: 0 },
      }),
    );

    const after = await computeSummary(db);

    /**
     * Position figures are CURRENT and ignore dates entirely: the money left the till when the
     * invoice was paid and the stock is on the shelf now, regardless of the date written on it.
     * Only ACTIVITY figures are re-sliced by a date filter.
     */
    expect(before.cashOnHandMinor - after.cashOnHandMinor).toBe(3_000);
    expect(after.inventoryAtCostMinor - before.inventoryAtCostMinor).toBe(3_000);
    expect(after.identityHolds).toBe(true);
    await assertInvariants(db);
  });

  it("a backdated receipt does not disturb an earlier period's profit", async () => {
    const batch = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1_000,
        landedCostMinor: 0,
        receivedAt: at("2026-03-01T10:00:00Z"),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
      }),
    );
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: batch.batchId, quantity: 5, unitPriceMinor: 200 }],
      }),
    );
    await db.execute(sql`UPDATE sales SET sold_at = '2026-03-15T10:00:00Z'`);

    const marchBefore = await computeSummary(db, {
      from: at("2026-03-01T00:00:00Z"),
      to: at("2026-04-01T00:00:00Z"),
    });

    // Backdate a receipt into February — a buying event, not a selling one.
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorB,
        gradeId: cat.gradeB,
        qtyReceived: 20,
        goodsCostMinor: 3_000,
        landedCostMinor: 0,
        receivedAt: at("2026-02-10T10:00:00Z"),
        funding: { newCapitalMinor: 3_000, reinvestedMinor: 0 },
      }),
    );

    const marchAfter = await computeSummary(db, {
      from: at("2026-03-01T00:00:00Z"),
      to: at("2026-04-01T00:00:00Z"),
    });

    // Buying stock is not a profit event, so March's trading profit is untouched. Profit moves
    // only when those units are SOLD.
    expect(marchAfter.profitToDateMinor).toBe(marchBefore.profitToDateMinor);
    await assertInvariants(db);
  });
});
