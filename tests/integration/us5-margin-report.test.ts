import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Tx } from "@/lib/db";
import { saleLines } from "@/lib/db/schema";
import { computeMarginReport, computeSaleDetail } from "@/lib/dal/reports-query";
import { recordCapitalInjection } from "@/lib/services/capital";
import { addLandedCost, receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";
import { recordSaleReturn } from "@/lib/services/sale-reversal";

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
    recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 1_000_000, occurredAt: new Date() }),
  );
});

async function receive(vendorId: number, gradeId: number, qty: number, costMinor: number) {
  const r = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId,
      gradeId,
      qtyReceived: qty,
      goodsCostMinor: costMinor,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: costMinor, reinvestedMinor: 0 },
    }),
  );
  return r.batchId;
}

describe("US5 — margin report and frozen attribution (FR-037, FR-038)", () => {
  it("per-vendor totals equal the sum of the matching sale lines", async () => {
    // Vendor A at 100/unit, Vendor B at 150/unit — same product, different economics.
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    const b = await receive(cat.vendorB, cat.gradeB, 10, 1_500);

    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [
          { batchId: a, quantity: 4, unitPriceMinor: 250 },
          { batchId: b, quantity: 2, unitPriceMinor: 250 },
        ],
      }),
    );

    const byVendor = await computeMarginReport(db, { groupBy: "vendor" });
    expect(byVendor).toHaveLength(2);

    const vendorA = byVendor.find((r) => r.label === "Vendor A")!;
    const vendorB = byVendor.find((r) => r.label === "Vendor B")!;

    // A: 4 × 250 = 1000 revenue, 4 × 100 = 400 cost, 600 profit, 60% margin.
    expect(vendorA).toMatchObject({
      revenueMinor: 1_000,
      costMinor: 400,
      profitMinor: 600,
      marginPercent: 60,
      unitsSold: 4,
    });
    // B: 2 × 250 = 500 revenue, 2 × 150 = 300 cost, 200 profit, 40% margin.
    expect(vendorB).toMatchObject({
      revenueMinor: 500,
      costMinor: 300,
      profitMinor: 200,
      marginPercent: 40,
      unitsSold: 2,
    });

    // Cross-check against the raw lines: the report must not invent or drop anything.
    const lines = await db.select().from(saleLines);
    const totalProfit = lines.reduce((s, l) => s + l.profitMinor, 0);
    expect(vendorA.profitMinor + vendorB.profitMinor).toBe(totalProfit);
    await assertInvariants(db);
  });

  it("groups by grade and by product with the same totals", async () => {
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    const b = await receive(cat.vendorB, cat.gradeB, 10, 1_500);
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [
          { batchId: a, quantity: 4, unitPriceMinor: 250 },
          { batchId: b, quantity: 2, unitPriceMinor: 250 },
        ],
      }),
    );

    const total = (rows: { profitMinor: number }[]) =>
      rows.reduce((s, r) => s + r.profitMinor, 0);

    const byVendor = await computeMarginReport(db, { groupBy: "vendor" });
    const byGrade = await computeMarginReport(db, { groupBy: "grade" });
    const byProduct = await computeMarginReport(db, { groupBy: "product" });

    // Same money, sliced three ways — the totals must agree.
    expect(total(byGrade)).toBe(total(byVendor));
    expect(total(byProduct)).toBe(total(byVendor));
    // One product, so grouping by product collapses to a single row.
    expect(byProduct).toHaveLength(1);
    expect(byProduct[0].profitMinor).toBe(800);
  });

  it("nets returned units out pro-rata rather than dropping the line", async () => {
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    const sale = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: a, quantity: 4, unitPriceMinor: 250 }],
      }),
    );

    await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "owner", {
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lines[0].saleLineId, quantity: 2 }],
        reason: "Changed mind",
        idempotencyId: 1,
      }),
    );

    const [row] = await computeMarginReport(db, { groupBy: "vendor" });
    // Half returned, so half the economics remain. Excluding the line entirely would report
    // zero, and keeping it whole would report a sale that partly did not happen.
    expect(row.unitsSold).toBe(2);
    expect(row.revenueMinor).toBe(500);
    expect(row.costMinor).toBe(200);
    expect(row.profitMinor).toBe(300);
    await assertInvariants(db);
  });

  it("excludes voided sales entirely", async () => {
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: a, quantity: 4, unitPriceMinor: 250 }],
      }),
    );
    const report = await computeMarginReport(db, { groupBy: "vendor" });
    expect(report).toHaveLength(1);
  });

  it("reports margin as null, not 0%, when there is no revenue", async () => {
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: a, quantity: 2, unitPriceMinor: 0 }],
      }),
    );
    const [row] = await computeMarginReport(db, { groupBy: "vendor" });
    // "0% margin" and "gave it away" are different facts; conflating them misleads.
    expect(row.marginPercent).toBeNull();
    expect(row.profitMinor).toBe(-200);
  });

  /** T088 — the reporting half of FR-007a. */
  it("the sale detail renders the FROZEN attribution after a cost correction", async () => {
    const a = await receive(cat.vendorA, cat.gradeA, 10, 1_000);
    const sale = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: a, quantity: 4, unitPriceMinor: 250 }],
      }),
    );

    const before = await computeSaleDetail(db, sale.saleId);
    expect(before!.lines[0].unitCostMinorAtSale).toBe(100);
    expect(before!.lines[0].vendorName).toBe("Vendor A");
    expect(before!.lines[0].batchCostCorrectedSince).toBe(false);

    // Freight raises the batch from 1000 to 1400 — unit cost would now be 140.
    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: a,
        additionalCostMinor: 400,
        idempotencyId: 2,
        reason: "Freight invoice arrived late",
      }),
    );

    const after = await computeSaleDetail(db, sale.saleId);
    // Still 100, still Vendor A, still the same profit. What that sale earned is history.
    expect(after!.lines[0].unitCostMinorAtSale).toBe(100);
    expect(after!.lines[0].costMinor).toBe(before!.lines[0].costMinor);
    expect(after!.lines[0].profitMinor).toBe(before!.lines[0].profitMinor);
    expect(after!.lines[0].vendorName).toBe("Vendor A");
    // ...but the owner is TOLD the batch changed, so the two views can be reconciled (FR-038).
    expect(after!.lines[0].batchCostCorrectedSince).toBe(true);

    // The margin report reads the same frozen figures.
    const [vendorRow] = await computeMarginReport(db, { groupBy: "vendor" });
    expect(vendorRow.costMinor).toBe(400);
    await assertInvariants(db);
  });

  it("returns null for a sale that does not exist", async () => {
    expect(await computeSaleDetail(db, 999_999)).toBeNull();
  });
});
