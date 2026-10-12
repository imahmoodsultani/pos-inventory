import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { batches, saleLines, sales } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

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

async function receive(opts: {
  vendorId: number;
  gradeId: number;
  qty: number;
  costMinor: number;
}) {
  const r = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: opts.vendorId,
      gradeId: opts.gradeId,
      qtyReceived: opts.qty,
      goodsCostMinor: opts.costMinor,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: opts.costMinor, reinvestedMinor: 0 },
    }),
  );
  return r.batchId;
}

describe("US2 — selling with exact cost and profit attribution", () => {
  it("draws only from the chosen batch and freezes its attribution", async () => {
    // Two batches of ONE product: Vendor A grade A at 100/unit, Vendor B grade B at 150/unit.
    const batchA = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 10,
      costMinor: 1000,
    });
    const batchB = await receive({
      vendorId: cat.vendorB,
      gradeId: cat.gradeB,
      qty: 10,
      costMinor: 1500,
    });

    const result = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: batchB, quantity: 3, unitPriceMinor: 250 }],
      }),
    );

    // profit = (price − effective unit cost) × 3 = (250 − 150) × 3 = 300
    expect(result.revenueMinor).toBe(750);
    expect(result.costMinor).toBe(450);
    expect(result.profitMinor).toBe(300);

    const [a] = await db.select().from(batches).where(eq(batches.id, batchA));
    const [b] = await db.select().from(batches).where(eq(batches.id, batchB));
    expect(a.qtyRemaining).toBe(10); // untouched
    expect(b.qtyRemaining).toBe(7);

    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, result.saleId));
    // The frozen columns record WHICH vendor and quality these units came from.
    expect(line.vendorIdAtSale).toBe(cat.vendorB);
    expect(line.gradeIdAtSale).toBe(cat.gradeB);
    expect(line.unitCostMinorAtSale).toBe(150);

    await assertInvariants(db);
  });

  it("sells below cost and stores a NEGATIVE profit rather than refusing (FR-017)", async () => {
    const batchId = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 10,
      costMinor: 1000,
    });

    // Clearing old stock at 60 against a unit cost of 100.
    const result = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 2, unitPriceMinor: 60 }],
      }),
    );

    expect(result.revenueMinor).toBe(120);
    expect(result.costMinor).toBe(200);
    expect(result.profitMinor).toBe(-80);

    const [sale] = await db.select().from(sales).where(eq(sales.id, result.saleId));
    expect(sale.profitMinor).toBe(-80);

    // A loss is a real business fact. Blocking it would force the owner to lie about the price
    // to clear stock, and the summary would then be wrong in a way nobody could see.
    await expectIdentity(db, { profitToDateMinor: -80 });
    await assertInvariants(db);
  });

  it("splits one product across batches as separate lines, each with its own cost (FR-018b)", async () => {
    const batchA = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 4,
      costMinor: 400,
    });
    const batchB = await receive({
      vendorId: cat.vendorB,
      gradeId: cat.gradeB,
      qty: 10,
      costMinor: 1500,
    });

    // A customer wants 6 but no single batch holds 6 of that quality mix.
    const result = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "card",
        lines: [
          { batchId: batchA, quantity: 4, unitPriceMinor: 200 },
          { batchId: batchB, quantity: 2, unitPriceMinor: 200 },
        ],
      }),
    );

    const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, result.saleId));
    expect(lines).toHaveLength(2);

    const fromA = lines.find((l) => l.batchId === batchA)!;
    const fromB = lines.find((l) => l.batchId === batchB)!;

    // Same product, same price, DIFFERENT cost and therefore different profit per line.
    expect(fromA.costMinor).toBe(400); // 4 × 100
    expect(fromB.costMinor).toBe(300); // 2 × 150
    expect(fromA.profitMinor).toBe(400);
    expect(fromB.profitMinor).toBe(100);
    expect(result.revenueMinor).toBe(1200);
    expect(result.profitMinor).toBe(500);

    await assertInvariants(db);
  });

  it("refuses to oversell a single line and leaves nothing behind", async () => {
    const batchId = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 2,
      costMinor: 200,
    });

    await expect(
      db.transaction((tx) =>
        recordSale(tx as Tx, ACTOR, {
          paymentMethod: "cash",
          lines: [{ batchId, quantity: 3, unitPriceMinor: 150 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const [row] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(row.qtyRemaining).toBe(2);
    expect(await db.select().from(sales)).toHaveLength(0);
    await assertInvariants(db);
  });

  it("rolls back the WHOLE basket when a later line cannot be filled", async () => {
    const good = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 10,
      costMinor: 1000,
    });
    const scarce = await receive({
      vendorId: cat.vendorB,
      gradeId: cat.gradeB,
      qty: 1,
      costMinor: 150,
    });

    await expect(
      db.transaction((tx) =>
        recordSale(tx as Tx, ACTOR, {
          paymentMethod: "cash",
          lines: [
            { batchId: good, quantity: 2, unitPriceMinor: 200 },
            { batchId: scarce, quantity: 5, unitPriceMinor: 200 }, // only 1 available
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    // The first line's decrement must NOT survive — a half-sold basket would leave the customer
    // charged for nothing and the stock gone.
    const [a] = await db.select().from(batches).where(eq(batches.id, good));
    expect(a.qtyRemaining).toBe(10);
    await assertInvariants(db);
  });

  it("keeps the identity exact across a sale", async () => {
    const batchId = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 10,
      costMinor: 1000,
    });

    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 5, unitPriceMinor: 150 }],
      }),
    );

    await expectIdentity(db, {
      capitalInvestedMinor: 1_000_000,
      profitToDateMinor: 250,
      cashOnHandMinor: 1_000_000 - 1000 + 750,
      inventoryAtCostMinor: 500,
    });
  });

  it("numbers sales sequentially and uniquely", async () => {
    const batchId = await receive({
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qty: 10,
      costMinor: 1000,
    });

    const first = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 1, unitPriceMinor: 150 }],
      }),
    );
    const second = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 1, unitPriceMinor: 150 }],
      }),
    );

    expect(first.saleNumber).toBe("S-00001");
    expect(second.saleNumber).toBe("S-00002");
  });
});
