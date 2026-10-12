import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { batches, saleLines, stockMovements } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { addLandedCost, receiveStock } from "@/lib/services/receiving";
import { costOfFirst } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";

import { ACTOR, injectCapital, seedCatalogue, sellUnits } from "./fixtures";
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
});

/**
 * FR-007a — changing a batch's cost AFTER some of its units have been sold.
 *
 * The fixture is the worked example from data-model.md §12, chosen because it is precisely the
 * case that used to break the accounting identity:
 *
 *   inject 1000 → buy 10 for 1000 → sell 5 at 150 → add 200 of landed cost
 *
 *   | after            | invested | profit | cash | inventory | LHS  | RHS  |
 *   | inject 1000      |     1000 |      0 | 1000 |         0 | 1000 | 1000 |
 *   | buy 10 @ 1000    |     1000 |      0 |    0 |      1000 | 1000 | 1000 |
 *   | sell 5 @ 150     |     1000 |    250 |  750 |       500 | 1250 | 1250 |
 *   | +200 landed cost |     1000 |    150 |  550 |       600 | 1150 | 1150 |
 */
describe("US1 — cost correction after units have been sold (FR-007a)", () => {
  async function arrange() {
    await injectCapital(db, 1000);

    const batch = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1000,
        landedCostMinor: 0,
        receivedAt: new Date("2026-02-01T09:00:00Z"),
        funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
      }),
    );

    const sale = await sellUnits(db, {
      batchId: batch.batchId,
      productId: cat.product,
      quantity: 5,
      unitPriceMinor: 150,
      saleNumber: "S-0001",
    });

    return { batch, sale };
  }

  it("matches the worked example at every step", async () => {
    const { batch, sale } = await arrange();

    // After the sale: cost of the first 5 of 10 units costing 1000 is exactly 500.
    expect(sale.costMinor).toBe(500);
    expect(sale.revenueMinor).toBe(750);
    await expectIdentity(db, {
      capitalInvestedMinor: 1000,
      profitToDateMinor: 250,
      cashOnHandMinor: 750,
      inventoryAtCostMinor: 500,
    });

    const result = await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 1,
        reason: "Freight invoice arrived late",
      }),
    );

    // The adjustment carries exactly the portion of the change already attributed to sold units:
    // costOfFirst(1200,10,5) - costOfFirst(1000,10,5) = 600 - 500 = 100.
    expect(result.adjustmentMinor).toBe(100);
    expect(result.totalCostMinor).toBe(1200);

    await expectIdentity(db, {
      capitalInvestedMinor: 1000,
      capitalRecoveredMinor: 0,
      profitToDateMinor: 150,
      cashOnHandMinor: 550,
      inventoryAtCostMinor: 600,
    });

    await assertInvariants(db);
  });

  it("never rewrites the frozen cost on an already-recorded sale line (FR-016, US5 s3)", async () => {
    const { batch, sale } = await arrange();

    const before = await db
      .select()
      .from(saleLines)
      .where(eq(saleLines.id, sale.saleLineId));

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 2,
        reason: "Freight",
      }),
    );

    const after = await db.select().from(saleLines).where(eq(saleLines.id, sale.saleLineId));

    // The whole point of the frozen columns. What that sale earned is history.
    expect(after[0].costMinor).toBe(before[0].costMinor);
    expect(after[0].unitCostMinorAtSale).toBe(before[0].unitCostMinorAtSale);
    expect(after[0].profitMinor).toBe(before[0].profitMinor);
    expect(after[0].vendorIdAtSale).toBe(before[0].vendorIdAtSale);
  });

  it("records the correction as a zero-quantity adjustment, visible in history", async () => {
    const { batch } = await arrange();

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 3,
        reason: "Freight invoice arrived late",
      }),
    );

    const adjustments = await db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.batchId, batch.batchId),
          eq(stockMovements.movementType, "adjustment"),
        ),
      );

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].qtyDelta).toBe(0);
    expect(adjustments[0].costMinor).toBe(100);
    expect(adjustments[0].reason).toBe("Freight invoice arrived late");
    // N2: distinct from the batch's own receipt row, or the unique index would reject it.
    expect(adjustments[0].refType).toBe("cost_correction");

    const [row] = await db.select().from(batches).where(eq(batches.id, batch.batchId));
    expect(row.isCostCorrected).toBe(true);
  });

  it("allows a SECOND correction of the same batch but rejects a true retry (N2)", async () => {
    const { batch } = await arrange();

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 10,
        reason: "Freight",
      }),
    );

    // A different correction later — a wrong rate discovered after the freight was added.
    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 60,
        idempotencyId: 11,
        reason: "Duty",
      }),
    );

    const adjustments = await db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.batchId, batch.batchId),
          eq(stockMovements.movementType, "adjustment"),
        ),
      );
    expect(adjustments).toHaveLength(2);

    // Replaying idempotencyId 11 is a duplicate write and must be refused by the unique index.
    await expect(
      db.transaction((tx) =>
        addLandedCost(tx as Tx, ACTOR, {
          batchId: batch.batchId,
          additionalCostMinor: 60,
          idempotencyId: 11,
          reason: "Duty",
        }),
      ),
    ).rejects.toThrow();

    await assertInvariants(db);
  });

  it("closes Invariant C once the batch is fully depleted", async () => {
    const { batch } = await arrange();

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 20,
        reason: "Freight",
      }),
    );

    // Sell the remaining 5 at the corrected cost.
    await sellUnits(db, {
      batchId: batch.batchId,
      productId: cat.product,
      quantity: 5,
      unitPriceMinor: 200,
      saleNumber: "S-0002",
    });

    const [row] = await db.select().from(batches).where(eq(batches.id, batch.batchId));
    expect(row.qtyRemaining).toBe(0);

    // Sales (500 + 600) + adjustment (100) = 1200 = total_cost_minor. Without the adjustment
    // row this sums to 1100 and Invariant C fails — which is the entire reason FR-007a exists.
    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.batchId, batch.batchId));
    const allocated = movements
      .filter((m) => m.movementType !== "receipt")
      .reduce((sum, m) => sum + m.costMinor, 0);
    expect(allocated).toBe(1200);

    await assertInvariants(db);
  });

  it("re-balances the funding allocation so FR-026 still holds", async () => {
    const { batch } = await arrange();

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 30,
        reason: "Freight",
      }),
    );

    const rows = await db.execute<{ funded: number; total: number }>(
      // Checked in SQL so this asserts what the database actually holds.
      // N1: this UPDATE is only possible because funding_allocations carries a DELETE-only
      // trigger. A blanket append-only trigger would have made addLandedCost throw.
      (await import("drizzle-orm")).sql`
        SELECT f.new_capital_minor + f.reinvested_minor AS funded, b.total_cost_minor AS total
          FROM funding_allocations f JOIN batches b ON b.id = f.batch_id
      `,
    );
    const row = (Array.isArray(rows) ? rows : rows.rows)[0];
    expect(Number(row.funded)).toBe(Number(row.total));
    expect(Number(row.total)).toBe(1200);
  });

  it("agrees with the pure allocation function", async () => {
    // Cross-check the database result against lib/domain, which is property-tested separately.
    const delta =
      costOfFirst(minor(1200) as Minor, 10, 5) - costOfFirst(minor(1000) as Minor, 10, 5);
    expect(delta).toBe(100);
  });
});
