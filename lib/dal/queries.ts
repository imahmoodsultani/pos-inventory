import "server-only";

/**
 * Read queries (T050).
 *
 * ROLE FILTERING HAPPENS BY NOT SELECTING (FR-041b, data-model §14). A salesperson's query never
 * puts a cost column in the SELECT list, so there is no moment at which cost data exists in a
 * response object that something could forget to strip. Fetching-then-deleting is how cost
 * figures end up in a serialised RSC payload that is invisible in the UI but present in the HTML.
 *
 * NONE of these are wrapped in `'use cache'`. Stock, prices, and cash are transactional; a
 * cached read would show a cashier stock that was already sold.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { batches, products, qualityGrades, vendors } from "@/lib/db/schema";
import { displayUnitCost } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { requireOwner, verifySession } from "@/lib/dal/session";

export type StockBatchRow = {
  batchId: number;
  productId: number;
  productCode: string;
  productName: string;
  vendorName: string;
  gradeCode: string;
  gradeLabel: string;
  qtyReceived: number;
  qtyRemaining: number;
  receivedAt: Date;
  totalCostMinor: number;
  unitCostFloorMinor: number;
  unitCostRemainderMinor: number;
  isCostCorrected: boolean;
};

/**
 * Stock on hand, batch by batch, with vendor, grade and unit cost (FR-036). OWNER ONLY — it
 * carries cost figures.
 */
export async function getStockOnHand(params?: {
  productId?: number;
}): Promise<StockBatchRow[]> {
  await requireOwner();

  const rows = await db
    .select({
      batchId: batches.id,
      productId: batches.productId,
      productCode: products.code,
      productName: products.name,
      vendorName: vendors.name,
      gradeCode: qualityGrades.code,
      gradeLabel: qualityGrades.label,
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      receivedAt: batches.receivedAt,
      totalCostMinor: batches.totalCostMinor,
      isCostCorrected: batches.isCostCorrected,
    })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .innerJoin(vendors, eq(vendors.id, batches.vendorId))
    .innerJoin(qualityGrades, eq(qualityGrades.id, batches.gradeId))
    .where(
      params?.productId
        ? and(gt(batches.qtyRemaining, 0), eq(batches.productId, params.productId))
        : gt(batches.qtyRemaining, 0),
    )
    .orderBy(asc(products.name), asc(batches.receivedAt), asc(batches.id));

  return rows.map((r) => {
    const { unitCostFloorMinor, remainderMinor } = displayUnitCost(
      minor(r.totalCostMinor) as Minor,
      r.qtyReceived,
    );
    return {
      ...r,
      unitCostFloorMinor,
      unitCostRemainderMinor: remainderMinor,
    };
  });
}

/**
 * The till's batch picker (FR-018). Available to SALESPEOPLE, so it must carry no cost.
 *
 * Note what is absent from this SELECT: total_cost_minor, goods_cost_minor, landed_cost_minor.
 * A salesperson needs to know which batch, from which vendor, at which quality, and how many are
 * left — never what it cost.
 */
export async function getStockAvailability(params?: {
  productId?: number;
}): Promise<
  Array<{
    batchId: number;
    productId: number;
    productCode: string;
    productName: string;
    vendorName: string;
    gradeCode: string;
    qtyRemaining: number;
    receivedAt: Date;
  }>
> {
  await verifySession();

  return db
    .select({
      batchId: batches.id,
      productId: batches.productId,
      productCode: products.code,
      productName: products.name,
      vendorName: vendors.name,
      gradeCode: qualityGrades.code,
      qtyRemaining: batches.qtyRemaining,
      receivedAt: batches.receivedAt,
    })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .innerJoin(vendors, eq(vendors.id, batches.vendorId))
    .innerJoin(qualityGrades, eq(qualityGrades.id, batches.gradeId))
    .where(
      params?.productId
        ? and(gt(batches.qtyRemaining, 0), eq(batches.productId, params.productId))
        : gt(batches.qtyRemaining, 0),
    )
    .orderBy(asc(products.name), asc(batches.receivedAt), asc(batches.id));
}

export type LowStockRow = {
  productId: number;
  code: string;
  name: string;
  onHand: number;
  reorderLevel: number;
};

/**
 * Products at or below their reorder level (FR-039).
 *
 * `reorder_level = 0` means NOT SET and is excluded. Without that, every product left at the
 * default would sit on the low-stock list permanently — and a list that is always full is a list
 * nobody reads, which defeats the point of having one.
 */
export async function getLowStock(): Promise<LowStockRow[]> {
  await requireOwner();

  const rows = await db
    .select({
      productId: products.id,
      code: products.code,
      name: products.name,
      reorderLevel: products.reorderLevel,
      onHand: sql<number>`COALESCE(SUM(${batches.qtyRemaining}), 0)`,
    })
    .from(products)
    .leftJoin(batches, eq(batches.productId, products.id))
    .where(and(eq(products.isActive, true), gt(products.reorderLevel, 0)))
    .groupBy(products.id, products.code, products.name, products.reorderLevel)
    .having(sql`COALESCE(SUM(${batches.qtyRemaining}), 0) <= ${products.reorderLevel}`)
    .orderBy(asc(products.name));

  return rows.map((r) => ({ ...r, onHand: Number(r.onHand) }));
}

/** Catalogue listings for the receiving form and management screens. */
export async function listProducts() {
  await requireOwner();
  return db.select().from(products).orderBy(asc(products.name));
}

export async function listVendors() {
  await requireOwner();
  return db.select().from(vendors).orderBy(asc(vendors.name));
}

export async function listQualityGrades() {
  await requireOwner();
  return db.select().from(qualityGrades).orderBy(asc(qualityGrades.sortOrder));
}

/** Recent batches, newest first — the receiving screen's "what did I just record" list. */
export async function listRecentBatches(limit = 25): Promise<StockBatchRow[]> {
  await requireOwner();
  const rows = await db
    .select({
      batchId: batches.id,
      productId: batches.productId,
      productCode: products.code,
      productName: products.name,
      vendorName: vendors.name,
      gradeCode: qualityGrades.code,
      gradeLabel: qualityGrades.label,
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      receivedAt: batches.receivedAt,
      totalCostMinor: batches.totalCostMinor,
      isCostCorrected: batches.isCostCorrected,
    })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .innerJoin(vendors, eq(vendors.id, batches.vendorId))
    .innerJoin(qualityGrades, eq(qualityGrades.id, batches.gradeId))
    .orderBy(desc(batches.receivedAt), desc(batches.id))
    .limit(limit);

  return rows.map((r) => {
    const { unitCostFloorMinor, remainderMinor } = displayUnitCost(
      minor(r.totalCostMinor) as Minor,
      r.qtyReceived,
    );
    return { ...r, unitCostFloorMinor, unitCostRemainderMinor: remainderMinor };
  });
}
