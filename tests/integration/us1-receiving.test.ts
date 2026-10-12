import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { batches, fundingAllocations, stockMovements } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { receiveStock } from "@/lib/services/receiving";
import { costOfFirst } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { assertInvariants, expectIdentity } from "./invariants";
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
  await injectCapital(db, 1_000_000);
});

describe("US1 — receiving into vendor- and quality-specific batches", () => {
  it("keeps two receipts of the same product completely separate", async () => {
    // The core claim of User Story 1: same product, different vendor, different quality,
    // different rate — and neither batch's cost is affected by the other.
    const a = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1000,
        landedCostMinor: 0,
        receivedAt: new Date("2026-01-10T10:00:00Z"),
        funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
      }),
    );

    const b = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorB,
        gradeId: cat.gradeB,
        qtyReceived: 20,
        goodsCostMinor: 3000,
        landedCostMinor: 0,
        receivedAt: new Date("2026-01-11T10:00:00Z"),
        funding: { newCapitalMinor: 3000, reinvestedMinor: 0 },
      }),
    );

    const rows = await db.select().from(batches);
    expect(rows).toHaveLength(2);

    const batchA = rows.find((r) => r.id === a.batchId)!;
    const batchB = rows.find((r) => r.id === b.batchId)!;

    // 100 per unit vs 150 per unit — stored nowhere, derived from each batch's own total.
    expect(batchA.totalCostMinor).toBe(1000);
    expect(batchB.totalCostMinor).toBe(3000);
    expect(batchA.vendorId).toBe(cat.vendorA);
    expect(batchB.vendorId).toBe(cat.vendorB);
    expect(batchA.gradeId).toBe(cat.gradeA);
    expect(batchB.gradeId).toBe(cat.gradeB);

    // On-hand for the product is the sum of both batches (FR-010).
    expect(batchA.qtyRemaining + batchB.qtyRemaining).toBe(30);

    // Per-unit costs stay distinct — this is what a pooled average cost would destroy.
    expect(costOfFirst(minor(batchA.totalCostMinor) as Minor, 10, 1)).toBe(100);
    expect(costOfFirst(minor(batchB.totalCostMinor) as Minor, 20, 1)).toBe(150);

    await assertInvariants(db);
  });

  it("writes exactly one receipt movement per batch, reconstructing qty_remaining", async () => {
    const r = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 7,
        goodsCostMinor: 700,
        landedCostMinor: 0,
        receivedAt: new Date(),
        funding: { newCapitalMinor: 700, reinvestedMinor: 0 },
      }),
    );

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.batchId, r.batchId));

    expect(movements).toHaveLength(1);
    expect(movements[0].movementType).toBe("receipt");
    expect(movements[0].qtyDelta).toBe(7);
    expect(movements[0].costMinor).toBe(700);
    await assertInvariants(db);
  });

  it("refuses a funding split that does not equal the total cost, writing nothing", async () => {
    await expect(
      db.transaction((tx) =>
        receiveStock(tx as Tx, ACTOR, {
          productId: cat.product,
          vendorId: cat.vendorA,
          gradeId: cat.gradeA,
          qtyReceived: 10,
          goodsCostMinor: 1000,
          landedCostMinor: 200,
          receivedAt: new Date(),
          // 1000 + 0 != 1200
          funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
        }),
      ),
    ).rejects.toMatchObject({ code: "FUNDING_MISMATCH" });

    // The check runs before any insert, so nothing is left behind.
    expect(await db.select().from(batches)).toHaveLength(0);
    await assertInvariants(db);
  });

  it("refuses to reinvest more than trading has actually produced (FR-029a)", async () => {
    // Nothing has been sold, so retained sale proceeds are zero.
    await expect(
      db.transaction((tx) =>
        receiveStock(tx as Tx, ACTOR, {
          productId: cat.product,
          vendorId: cat.vendorA,
          gradeId: cat.gradeA,
          qtyReceived: 10,
          goodsCostMinor: 1000,
          landedCostMinor: 0,
          receivedAt: new Date(),
          funding: { newCapitalMinor: 0, reinvestedMinor: 1000 },
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(await db.select().from(batches)).toHaveLength(0);
  });

  it("refuses a purchase that would drive cash negative (FR-031)", async () => {
    await expect(
      db.transaction((tx) =>
        receiveStock(tx as Tx, ACTOR, {
          productId: cat.product,
          vendorId: cat.vendorA,
          gradeId: cat.gradeA,
          qtyReceived: 10,
          goodsCostMinor: 9_999_999,
          landedCostMinor: 0,
          receivedAt: new Date(),
          funding: { newCapitalMinor: 9_999_999, reinvestedMinor: 0 },
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" });

    expect(await db.select().from(batches)).toHaveLength(0);
    await assertInvariants(db);
  });

  it("every batch has a funding allocation summing to its total cost (SC-004)", async () => {
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 900,
        landedCostMinor: 100,
        receivedAt: new Date(),
        funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
      }),
    );

    const [batch] = await db.select().from(batches);
    const [funding] = await db
      .select()
      .from(fundingAllocations)
      .where(eq(fundingAllocations.batchId, batch.id));

    expect(funding.newCapitalMinor + funding.reinvestedMinor).toBe(batch.totalCostMinor);
  });

  it("keeps the accounting identity exact after a purchase (SC-003)", async () => {
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1000,
        landedCostMinor: 0,
        receivedAt: new Date(),
        funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
      }),
    );

    // Buying stock moves value from cash to inventory; it must not change capital invested.
    // Counting the new-capital portion of the purchase as "invested" is exactly the
    // double-count that FR-026a exists to prevent.
    await expectIdentity(db, {
      capitalInvestedMinor: 1_000_000,
      capitalRecoveredMinor: 0,
      profitToDateMinor: 0,
      cashOnHandMinor: 999_000,
      inventoryAtCostMinor: 1000,
    });
  });
});
