import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { batches, qualityGrades, vendors } from "@/lib/db/schema";
import { computeMarginReport } from "@/lib/dal/reports-query";
import { getEditHistory } from "@/lib/services/audit";
import {
  createProduct,
  updateProduct,
  updateQualityGrade,
  updateVendor,
} from "@/lib/services/catalogue";
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
    recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 1_000_000, occurredAt: new Date() }),
  );
});

async function sellFrom(vendorId: number, gradeId: number) {
  const batch = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId,
      gradeId,
      qtyReceived: 10,
      goodsCostMinor: 1_000,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
    }),
  );
  await db.transaction((tx) =>
    recordSale(tx as Tx, ACTOR, {
      paymentMethod: "cash",
      lines: [{ batchId: batch.batchId, quantity: 4, unitPriceMinor: 250 }],
    }),
  );
  return batch;
}

describe("catalogue editing (FR-045, FR-048)", () => {
  it("renaming a referenced vendor preserves attribution and does NOT split the margin report", async () => {
    await sellFrom(cat.vendorA, cat.gradeA);

    const before = await computeMarginReport(db, { groupBy: "vendor" });
    expect(before).toHaveLength(1);
    expect(before[0].label).toBe("Vendor A");

    await db.transaction((tx) =>
      updateVendor(tx as Tx, ACTOR, { vendorId: cat.vendorA, name: "Vendor A Trading Co" }),
    );

    const after = await computeMarginReport(db, { groupBy: "vendor" });

    // One vendor, one row, same economics. This is the whole reason editing exists rather than
    // "deactivate and recreate" — recreating would produce two rows for one supplier.
    expect(after).toHaveLength(1);
    expect(after[0].label).toBe("Vendor A Trading Co");
    expect(after[0].profitMinor).toBe(before[0].profitMinor);
    expect(after[0].unitsSold).toBe(before[0].unitsSold);

    // The batch still points at the same vendor id.
    const [batch] = await db.select().from(batches);
    expect(batch.vendorId).toBe(cat.vendorA);
    await assertInvariants(db);
  });

  it("refuses a rename that collides with another vendor, case-insensitively", async () => {
    const error = (await db
      .transaction((tx) =>
        updateVendor(tx as Tx, ACTOR, { vendorId: cat.vendorB, name: "vendor a" }),
      )
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/already exists/i);

    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, cat.vendorB));
    expect(vendor.name).toBe("Vendor B");
  });

  it("allows a vendor to keep its own name — that is a no-op, not a conflict", async () => {
    await db.transaction((tx) =>
      updateVendor(tx as Tx, ACTOR, { vendorId: cat.vendorA, name: "Vendor A", phone: "0300" }),
    );
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, cat.vendorA));
    expect(vendor.phone).toBe("0300");
  });

  it("writes an audit record naming who changed what", async () => {
    await db.transaction((tx) =>
      updateVendor(tx as Tx, ACTOR, {
        vendorId: cat.vendorA,
        name: "Northside Supply",
        phone: "0300-111",
      }),
    );

    const history = await getEditHistory(db, "vendors", cat.vendorA);
    expect(history).toHaveLength(2);
    expect(new Set(history.map((h) => h.editGroup)).size).toBe(1);
    expect(history.every((h) => h.changedBy === ACTOR)).toBe(true);

    const name = history.find((h) => h.fieldName === "name")!;
    expect(name.oldValue).toBe("Vendor A");
    expect(name.newValue).toBe("Northside Supply");
  });

  it("writes nothing when an edit changes nothing", async () => {
    await db.transaction((tx) =>
      updateVendor(tx as Tx, ACTOR, { vendorId: cat.vendorA, name: "Vendor A" }),
    );
    expect(await getEditHistory(db, "vendors", cat.vendorA)).toHaveLength(0);
  });

  it("corrects a grade label without touching recorded sales", async () => {
    await sellFrom(cat.vendorA, cat.gradeA);
    const beforeReport = await computeMarginReport(db, { groupBy: "grade" });

    await db.transaction((tx) =>
      updateQualityGrade(tx as Tx, ACTOR, { gradeId: cat.gradeA, label: "Premium" }),
    );

    const [grade] = await db.select().from(qualityGrades).where(eq(qualityGrades.id, cat.gradeA));
    expect(grade.label).toBe("Premium");
    // The code is what sale lines are grouped by, so it must be unchanged.
    expect(grade.code).toBe("A");

    const afterReport = await computeMarginReport(db, { groupBy: "grade" });
    expect(afterReport[0].profitMinor).toBe(beforeReport[0].profitMinor);
    await assertInvariants(db);
  });

  it("cannot change a product's unit of measure (FR-048)", async () => {
    const created = await db.transaction((tx) =>
      createProduct(tx as Tx, ACTOR, {
        code: "WIDGET-2",
        name: "Widget Two",
        unitOfMeasure: "piece",
      }),
    );

    // The input type has no unitOfMeasure field at all — unrepresentable rather than merely
    // discouraged. Passing it anyway must leave the stored value untouched.
    await db.transaction((tx) =>
      updateProduct(tx as Tx, ACTOR, {
        productId: created.productId,
        name: "Widget Two Renamed",
        ...({ unitOfMeasure: "box" } as object),
      }),
    );

    const rows = await db.execute<{ unit_of_measure: string }>(
      (await import("drizzle-orm")).sql`
        SELECT unit_of_measure FROM products WHERE id = ${created.productId}
      `,
    );
    const row = (Array.isArray(rows) ? rows : (rows as { rows: { unit_of_measure: string }[] }).rows)[0];
    expect(row.unit_of_measure).toBe("piece");
  });

  it("product edits are audited too", async () => {
    await db.transaction((tx) =>
      updateProduct(tx as Tx, ACTOR, { productId: cat.product, reorderLevel: 5 }),
    );
    const history = await getEditHistory(db, "products", cat.product);
    expect(history).toHaveLength(1);
    expect(history[0].fieldName).toBe("reorderLevel");
    expect(history[0].newValue).toBe("5");
  });
});
