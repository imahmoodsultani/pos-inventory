import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { batches, saleLines, sales, stockMovements } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { receiveStock, addLandedCost } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";
import { recordSaleReturn, recordSaleVoid } from "@/lib/services/sale-reversal";

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
  await injectCapital(db, 1_000_000);
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

async function sellFour() {
  return db.transaction((tx) =>
    recordSale(tx as Tx, ACTOR, {
      paymentMethod: "cash",
      lines: [{ batchId, quantity: 4, unitPriceMinor: 150 }],
    }),
  );
}

describe("US2 — returns and voids (FR-021, FR-022, FR-042)", () => {
  it("a partial return restores units to the ORIGINAL batch and reduces profit", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    const result = await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "owner", {
        saleId: sale.saleId,
        lines: [{ saleLineId: line.id, quantity: 2 }],
        reason: "Customer changed their mind",
        idempotencyId: 1,
      }),
    );

    expect(result.status).toBe("partially_returned");
    expect(result.refundMinor).toBe(300); // 2 × 150
    expect(result.reversedCostMinor).toBe(200); // 2 × 100, the frozen cost
    expect(result.reversedProfitMinor).toBe(100);

    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch.qtyRemaining).toBe(8); // 10 − 4 + 2

    const [updated] = await db.select().from(saleLines).where(eq(saleLines.id, line.id));
    expect(updated.qtyReturned).toBe(2);
    // The original line is NOT rewritten — it still records what was sold.
    expect(updated.quantity).toBe(4);
    expect(updated.revenueMinor).toBe(600);

    await assertInvariants(db);
  });

  it("returns at the ORIGINAL frozen cost even after the batch cost was corrected", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    // Freight arrives after the sale, raising the batch from 1000 to 1200.
    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId,
        additionalCostMinor: 200,
        idempotencyId: 50,
        reason: "Freight",
      }),
    );

    const result = await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "owner", {
        saleId: sale.saleId,
        lines: [{ saleLineId: line.id, quantity: 2 }],
        reason: "Faulty",
        idempotencyId: 2,
      }),
    );

    // Still 200, not 240. Recomputing from the corrected batch would make the return a
    // different amount from the sale it reverses, and profit would drift by the difference.
    expect(result.reversedCostMinor).toBe(200);
    await assertInvariants(db);
  });

  it("marks a sale fully returned once every unit is back", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "owner", {
        saleId: sale.saleId,
        lines: [{ saleLineId: line.id, quantity: 4 }],
        reason: "All faulty",
        idempotencyId: 3,
      }),
    );

    const [row] = await db.select().from(sales).where(eq(sales.id, sale.saleId));
    expect(row.status).toBe("returned");

    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch.qtyRemaining).toBe(10);
    await assertInvariants(db);
  });

  it("refuses to return more than was sold", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    await expect(
      db.transaction((tx) =>
        recordSaleReturn(tx as Tx, ACTOR, "owner", {
          saleId: sale.saleId,
          lines: [{ saleLineId: line.id, quantity: 5 }],
          reason: "Too many",
          idempotencyId: 4,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("hides the reversed cost and profit from a SALESPERSON (FR-021)", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    const result = await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "salesperson", {
        saleId: sale.saleId,
        lines: [{ saleLineId: line.id, quantity: 1 }],
        reason: "Customer changed their mind",
        idempotencyId: 5,
      }),
    );

    // They need the refund to hand over. They must not learn the margin from it.
    expect(result.refundMinor).toBe(150);
    expect("reversedCostMinor" in result).toBe(false);
    expect("reversedProfitMinor" in result).toBe(false);
  });

  it("a void writes reversing rows and DELETES NOTHING (FR-042)", async () => {
    const sale = await sellFour();

    const result = await db.transaction((tx) =>
      recordSaleVoid(tx as Tx, ACTOR, {
        saleId: sale.saleId,
        reason: "Rung up on the wrong account",
        idempotencyId: 6,
      }),
    );

    expect(result.status).toBe("voided");
    expect(result.reversedRevenueMinor).toBe(600);

    // The sale row survives, annotated with who voided it and why.
    const [row] = await db.select().from(sales).where(eq(sales.id, sale.saleId));
    expect(row.status).toBe("voided");
    expect(row.voidReason).toBe("Rung up on the wrong account");
    expect(row.voidedBy).toBe(ACTOR);
    expect(row.revenueMinor).toBe(600); // original figures intact

    // Its lines survive too.
    const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));
    expect(lines).toHaveLength(1);

    // And the ledger gained a reversing row rather than losing the original.
    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.batchId, batchId));
    const types = movements.map((m) => m.movementType).sort();
    expect(types).toEqual(["receipt", "sale", "sale_return"]);

    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch.qtyRemaining).toBe(10);
    await assertInvariants(db);
  });

  it("refuses to void twice", async () => {
    const sale = await sellFour();
    await db.transaction((tx) =>
      recordSaleVoid(tx as Tx, ACTOR, {
        saleId: sale.saleId,
        reason: "Mistake",
        idempotencyId: 7,
      }),
    );

    await expect(
      db.transaction((tx) =>
        recordSaleVoid(tx as Tx, ACTOR, {
          saleId: sale.saleId,
          reason: "Mistake again",
          idempotencyId: 8,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to return against a voided sale", async () => {
    const sale = await sellFour();
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.saleId));

    await db.transaction((tx) =>
      recordSaleVoid(tx as Tx, ACTOR, {
        saleId: sale.saleId,
        reason: "Mistake",
        idempotencyId: 9,
      }),
    );

    await expect(
      db.transaction((tx) =>
        recordSaleReturn(tx as Tx, ACTOR, "owner", {
          saleId: sale.saleId,
          lines: [{ saleLineId: line.id, quantity: 1 }],
          reason: "Too late",
          idempotencyId: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
