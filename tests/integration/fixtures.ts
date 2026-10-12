/**
 * Shared fixtures for integration tests.
 *
 * `sellUnits` writes a sale directly rather than calling recordSale, which does not exist until
 * Phase 4. It performs the SAME guarded conditional UPDATE and the SAME prefix-difference cost
 * allocation the real sale path will, so cost-attribution assertions remain meaningful; it just
 * skips the parts (idempotency, sale numbering, role checks) that those tests are not about.
 */

import { and, eq, sql } from "drizzle-orm";

import {
  batches,
  capitalEvents,
  cashEvents,
  products,
  qualityGrades,
  saleLines,
  sales,
  stockMovements,
  vendors,
} from "@/lib/db/schema";
import { costOfFirst } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import type { TestDb } from "./setup";

export const ACTOR = "test-owner";

export async function seedCatalogue(db: TestDb) {
  const [vendorA] = await db
    .insert(vendors)
    .values({ name: "Vendor A", createdBy: ACTOR })
    .returning({ id: vendors.id });
  const [vendorB] = await db
    .insert(vendors)
    .values({ name: "Vendor B", createdBy: ACTOR })
    .returning({ id: vendors.id });
  const [gradeA] = await db
    .insert(qualityGrades)
    .values({ code: "A", label: "Premium", sortOrder: 1, createdBy: ACTOR })
    .returning({ id: qualityGrades.id });
  const [gradeB] = await db
    .insert(qualityGrades)
    .values({ code: "B", label: "Standard", sortOrder: 2, createdBy: ACTOR })
    .returning({ id: qualityGrades.id });
  const [product] = await db
    .insert(products)
    .values({ code: "WIDGET", name: "Widget", unitOfMeasure: "piece", createdBy: ACTOR })
    .returning({ id: products.id });

  return { vendorA: vendorA.id, vendorB: vendorB.id, gradeA: gradeA.id, gradeB: gradeB.id, product: product.id };
}

/** Put money in the business so purchases have something to spend (FR-024). */
export async function injectCapital(db: TestDb, amountMinor: number): Promise<void> {
  const [event] = await db
    .insert(capitalEvents)
    .values({
      eventType: "injection",
      amountMinor,
      occurredAt: new Date(),
      createdBy: ACTOR,
    })
    .returning({ id: capitalEvents.id });

  await db.insert(cashEvents).values({
    direction: "in",
    amountMinor,
    sourceType: "capital_injection",
    sourceId: event.id,
    occurredAt: new Date(),
    createdBy: ACTOR,
  });
}

/**
 * Sell `quantity` units out of `batchId`, freezing cost exactly as the real sale path will.
 * Returns the sale line's frozen unit cost and the slice cost.
 */
export async function sellUnits(
  db: TestDb,
  params: {
    batchId: number;
    productId: number;
    quantity: number;
    unitPriceMinor: number;
    saleNumber: string;
  },
): Promise<{ saleId: number; saleLineId: number; costMinor: number; revenueMinor: number }> {
  const decremented = await db
    .update(batches)
    .set({ qtyRemaining: sql`${batches.qtyRemaining} - ${params.quantity}` })
    .where(
      and(eq(batches.id, params.batchId), sql`${batches.qtyRemaining} >= ${params.quantity}`),
    )
    .returning({
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      totalCostMinor: batches.totalCostMinor,
      vendorId: batches.vendorId,
      gradeId: batches.gradeId,
    });

  if (decremented.length === 0) throw new Error("fixture: insufficient stock");
  const b = decremented[0];

  const consumedAfter = b.qtyReceived - b.qtyRemaining;
  const consumedBefore = consumedAfter - params.quantity;
  const costMinor =
    costOfFirst(minor(b.totalCostMinor) as Minor, b.qtyReceived, consumedAfter) -
    costOfFirst(minor(b.totalCostMinor) as Minor, b.qtyReceived, consumedBefore);
  const revenueMinor = params.unitPriceMinor * params.quantity;

  const [sale] = await db
    .insert(sales)
    .values({
      saleNumber: params.saleNumber,
      paymentMethod: "cash",
      revenueMinor,
      costMinor,
      profitMinor: revenueMinor - costMinor,
      createdBy: ACTOR,
    })
    .returning({ id: sales.id });

  const [line] = await db
    .insert(saleLines)
    .values({
      saleId: sale.id,
      batchId: params.batchId,
      productId: params.productId,
      quantity: params.quantity,
      unitPriceMinor: params.unitPriceMinor,
      // The three frozen columns — copies, never joins.
      vendorIdAtSale: b.vendorId,
      gradeIdAtSale: b.gradeId,
      unitCostMinorAtSale: Math.floor(costMinor / params.quantity),
      revenueMinor,
      costMinor,
      profitMinor: revenueMinor - costMinor,
    })
    .returning({ id: saleLines.id });

  await db.insert(stockMovements).values({
    batchId: params.batchId,
    movementType: "sale",
    qtyDelta: -params.quantity,
    costMinor,
    refType: "sale_line",
    refId: line.id,
    createdBy: ACTOR,
  });

  await db.insert(cashEvents).values({
    direction: "in",
    amountMinor: revenueMinor,
    sourceType: "sale",
    sourceId: sale.id,
    occurredAt: new Date(),
    createdBy: ACTOR,
  });

  return { saleId: sale.id, saleLineId: line.id, costMinor, revenueMinor };
}
