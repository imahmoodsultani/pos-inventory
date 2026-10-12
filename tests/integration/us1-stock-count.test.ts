import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { batches, stockMovements } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { receiveStock } from "@/lib/services/receiving";
import { recordStockCount, recordWriteOff } from "@/lib/services/stock-corrections";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { assertInvariants } from "./invariants";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

let db: TestDb;
let cat: Awaited<ReturnType<typeof seedCatalogue>>;
let batchId: number;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});
beforeEach(async () => {
  await truncateAll();
  cat = await seedCatalogue(db);
  await injectCapital(db, 100_000);
  const r = await db.transaction((tx) =>
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
  batchId = r.batchId;
});

describe("US1 — stock counts and write-offs (FR-011, FR-012)", () => {
  it("records a shortfall as an adjustment movement, not a quantity edit", async () => {
    const result = await db.transaction((tx) =>
      recordStockCount(tx as Tx, ACTOR, {
        counts: [{ batchId, countedQty: 8 }],
        reason: "Monthly count — two units missing",
        idempotencyId: 1,
      }),
    );

    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].deltaQty).toBe(-2);

    const movements = await db
      .select()
      .from(stockMovements)
      .where(
        and(eq(stockMovements.batchId, batchId), eq(stockMovements.movementType, "adjustment")),
      );

    expect(movements).toHaveLength(1);
    expect(movements[0].qtyDelta).toBe(-2);
    /**
     * SIGN CONVENTION, which is easy to get backwards: `cost_minor` is POSITIVE when cost
     * leaves the batch, exactly as it is for a sale. Two of ten units costing 1000 is 200.
     *
     * `qty_delta` is signed by direction (-2, units gone) but `cost_minor` is signed by
     * ALLOCATION (+200, cost consumed). That is what makes Invariant C close — sales,
     * write-offs and shortfalls all add up to total_cost_minor — and what makes the summary's
     * `profit = sale profit − Σ adjustment cost` subtract a loss rather than add it.
     *
     * A surplus inverts it: finding a unit yields a negative cost_minor, returning value to the
     * batch and to profit.
     */
    expect(movements[0].costMinor).toBe(200);
    expect(movements[0].reason).toContain("Monthly count");

    // Invariant A proves the cached quantity still reconstructs from the ledger — which is the
    // whole reason the adjustment exists rather than a bare UPDATE.
    await assertInvariants(db);
  });

  it("writes nothing for batches that match the count", async () => {
    const result = await db.transaction((tx) =>
      recordStockCount(tx as Tx, ACTOR, {
        counts: [{ batchId, countedQty: 10 }],
        reason: "Monthly count",
        idempotencyId: 2,
      }),
    );

    expect(result.adjustments).toHaveLength(0);
    const movements = await db
      .select()
      .from(stockMovements)
      .where(
        and(eq(stockMovements.batchId, batchId), eq(stockMovements.movementType, "adjustment")),
      );
    // A zero-delta "adjustment" would violate the qty_delta CHECK and bury real discrepancies.
    expect(movements).toHaveLength(0);
  });

  it("records a surplus too", async () => {
    await db.transaction((tx) =>
      recordStockCount(tx as Tx, ACTOR, {
        counts: [{ batchId, countedQty: 10 }],
        reason: "baseline",
        idempotencyId: 3,
      }),
    );
    // Sell nothing; pretend 10 were miscounted earlier and there are really... still 10.
    // Instead, write off 3 then find 1 again.
    await db.transaction((tx) =>
      recordWriteOff(tx as Tx, ACTOR, {
        batchId,
        quantity: 3,
        reason: "Water damage",
        idempotencyId: 4,
      }),
    );

    const found = await db.transaction((tx) =>
      recordStockCount(tx as Tx, ACTOR, {
        counts: [{ batchId, countedQty: 8 }],
        reason: "One turned up behind the shelf",
        idempotencyId: 5,
      }),
    );

    expect(found.adjustments[0].deltaQty).toBe(1);
    await assertInvariants(db);
  });

  it("rejects a write-off with no reason — at the DATABASE, not only in Zod", async () => {
    // The service refuses first, with a friendly message...
    await expect(
      db.transaction((tx) =>
        recordWriteOff(tx as Tx, ACTOR, {
          batchId,
          quantity: 1,
          reason: "   ",
          idempotencyId: 6,
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // ...but the guarantee is the CHECK constraint. Bypass the service entirely and confirm the
    // database still refuses: validation can be forgotten, a constraint cannot.
    //
    // Asserted against the driver error's `constraint` field rather than the message, because
    // drizzle wraps failures in its own "Failed query:" text and the constraint name — the part
    // that proves WHICH rule fired — survives only on the cause.
    const attempt = db.insert(stockMovements).values({
      batchId,
      movementType: "write_off",
      qtyDelta: -1,
      costMinor: 100,
      reason: null,
      refType: "stock_count",
      refId: 999,
      createdBy: ACTOR,
    });

    await expect(attempt).rejects.toThrow();
    const error = await attempt.catch((e: unknown) => e);
    const cause = (error as { cause?: { constraint?: string; code?: string } }).cause;
    expect(cause?.constraint).toBe("stock_movements_reason_required");
    expect(cause?.code).toBe("23514"); // check_violation
  });

  it("refuses to write off more than remains, using the guarded UPDATE", async () => {
    await expect(
      db.transaction((tx) =>
        recordWriteOff(tx as Tx, ACTOR, {
          batchId,
          quantity: 11,
          reason: "Fire",
          idempotencyId: 7,
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const [row] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(row.qtyRemaining).toBe(10);
    await assertInvariants(db);
  });

  it("a write-off reduces inventory and profit without moving cash", async () => {
    await db.transaction((tx) =>
      recordWriteOff(tx as Tx, ACTOR, {
        batchId,
        quantity: 2,
        reason: "Damaged in transit",
        idempotencyId: 8,
      }),
    );

    // Destroyed value does not move money. Inventory falls by 200, profit falls by 200, cash is
    // untouched — and the identity still balances, which is the real assertion here.
    await assertInvariants(db);
  });
});
