import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { products, vendors } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import {
  createProduct,
  createVendor,
  deactivateProduct,
  deactivateVendor,
  deleteProduct,
  deleteQualityGrade,
  deleteVendor,
} from "@/lib/services/catalogue";
import { receiveStock } from "@/lib/services/receiving";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";


/** `.catch(e => e)` widens to a union with the success type; this narrows it back. */
function asError(value: unknown): { code: string; message: string } {
  return value as { code: string; message: string };
}

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
  await injectCapital(db, 100_000);
});

async function receiveOne() {
  return db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qtyReceived: 5,
      goodsCostMinor: 500,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: 500, reinvestedMinor: 0 },
    }),
  );
}

/**
 * FR-004. Deleting a referenced catalogue entry would orphan the cost attribution on every
 * batch and sale line pointing at it — the precise history this system exists to preserve.
 * Refusal must NAME what references the row, so the owner knows what to do instead.
 */
describe("US1 — referential guard (FR-004)", () => {
  it("refuses to delete a referenced product, naming the references", async () => {
    await receiveOne();

    const error = await db
      .transaction((tx) => deleteProduct(tx as Tx, ACTOR, { productId: cat.product }))
      .catch((e: unknown) => e as { code: string; message: string });

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("1 batch");
    // Tells the owner the way forward rather than just saying no.
    expect(error.message).toContain("Deactivate");
  });

  it("refuses to delete a referenced vendor, naming the references", async () => {
    await receiveOne();

    const error = await db
      .transaction((tx) => deleteVendor(tx as Tx, ACTOR, { vendorId: cat.vendorA }))
      .catch((e: unknown) => e as { code: string; message: string });

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("1 batch");
  });

  it("refuses to delete a referenced quality grade", async () => {
    await receiveOne();

    const error = await db
      .transaction((tx) => deleteQualityGrade(tx as Tx, ACTOR, { gradeId: cat.gradeA }))
      .catch((e: unknown) => e as { code: string; message: string });

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("1 batch");
  });

  it("deactivation succeeds instead, and history survives", async () => {
    const batch = await receiveOne();

    await db.transaction((tx) => deactivateVendor(tx as Tx, ACTOR, { vendorId: cat.vendorA }));
    await db.transaction((tx) =>
      deactivateProduct(tx as Tx, ACTOR, { productId: cat.product }),
    );

    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, cat.vendorA));
    const [product] = await db.select().from(products).where(eq(products.id, cat.product));
    expect(vendor.isActive).toBe(false);
    expect(product.isActive).toBe(false);

    // The batch still points at both and still knows what it cost. Deactivation hides an entry
    // from NEW receipts; it never rewrites the past.
    expect(batch.totalCostMinor).toBe(500);
    expect(vendor.name).toBe("Vendor A");
  });

  it("still refuses deletion even when nothing references the row", async () => {
    // Catalogue entries are never hard-deleted, referenced or not. Allowing it "just this once"
    // when the count is zero creates a window where an owner deletes a vendor they typo'd,
    // between a receipt being recorded and the page refreshing.
    const fresh = await db.transaction((tx) =>
      createVendor(tx as Tx, ACTOR, { name: "Unused Vendor" }),
    );

    const error = await db
      .transaction((tx) => deleteVendor(tx as Tx, ACTOR, { vendorId: fresh.vendorId }))
      .catch((e: unknown) => e as { code: string; message: string });

    expect(error.code).toBe("CONFLICT");
    expect(error.message.toLowerCase()).toContain("deactivate");
  });

  it("rejects a duplicate vendor name case-insensitively", async () => {
    const error = asError(
      await db
        .transaction((tx) => createVendor(tx as Tx, ACTOR, { name: "vendor a" }))
        .catch((e: unknown) => e),
    );

    // "Acme" and "ACME" are one supplier. Two rows would split their margin report in half.
    expect(error.code).toBe("CONFLICT");
  });

  it("rejects a duplicate product code case-insensitively", async () => {
    const error = asError(
      await db
        .transaction((tx) =>
          createProduct(tx as Tx, ACTOR, {
            code: "widget",
            name: "Another Widget",
            unitOfMeasure: "piece",
          }),
        )
        .catch((e: unknown) => e),
    );

    expect(error.code).toBe("CONFLICT");
  });

  it("rejects a non-countable unit of measure (FR-001)", async () => {
    await expect(
      db.transaction((tx) =>
        createProduct(tx as Tx, ACTOR, {
          code: "RICE",
          name: "Rice",
          // Deliberately bypassing the Zod enum to prove the DATABASE refuses it too.
          unitOfMeasure: "kg" as "piece",
        }),
      ),
    ).rejects.toThrow();
  });
});
