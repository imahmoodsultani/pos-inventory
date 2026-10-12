/**
 * Report QUERIES (T090, T091, FR-037, FR-038).
 *
 * Executor-taking and pool-free, for the same reason as summary-query.ts: a query has no
 * business forcing DATABASE_URL to be set just to be tested. The auth boundary lives in
 * ./reports.ts.
 *
 * ⚠️ EVERY FIGURE HERE COMES FROM THE FROZEN `*_at_sale` COLUMNS, never from a join through to
 * the batch's current state. A batch whose cost was corrected last week must not retroactively
 * change what a sale earned last month — that is the whole point of freezing them (FR-016,
 * FR-038, US5 scenario 3), and a convenient `JOIN batches` would silently undo it.
 */

import { sql } from "drizzle-orm";
import type { Database, Tx } from "@/lib/db";

type Executor = Database | Tx;

export type SaleDetailLine = {
  saleLineId: number;
  productCode: string;
  productName: string;
  /** The vendor as recorded AT SALE TIME. */
  vendorName: string;
  /** The grade as recorded AT SALE TIME. */
  gradeCode: string;
  quantity: number;
  qtyReturned: number;
  unitPriceMinor: number;
  /** Frozen. Not the batch's cost today. */
  unitCostMinorAtSale: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  batchId: number;
  /** True when the source batch's cost has since been corrected (FR-038). */
  batchCostCorrectedSince: boolean;
};

export type SaleDetail = {
  saleId: number;
  saleNumber: string;
  soldAt: Date;
  status: string;
  paymentMethod: string;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  voidReason: string | null;
  lines: SaleDetailLine[];
};

export async function computeSaleDetail(
  dbx: Executor,
  saleId: number,
): Promise<SaleDetail | null> {
  const headerRows = rows<SaleDetail>(
    await dbx.execute(sql`
      SELECT id AS "saleId", sale_number AS "saleNumber", sold_at AS "soldAt",
             status, payment_method AS "paymentMethod",
             revenue_minor::bigint AS "revenueMinor",
             cost_minor::bigint    AS "costMinor",
             profit_minor::bigint  AS "profitMinor",
             void_reason AS "voidReason"
        FROM sales WHERE id = ${saleId}
    `),
  );
  if (headerRows.length === 0) return null;

  const lines = rows<SaleDetailLine>(
    await dbx.execute(sql`
      SELECT
        sl.id                        AS "saleLineId",
        p.code                       AS "productCode",
        p.name                       AS "productName",
        -- Joined on the FROZEN vendor/grade ids, not on the batch's current ones.
        v.name                       AS "vendorName",
        g.code                       AS "gradeCode",
        sl.quantity                  AS "quantity",
        sl.qty_returned              AS "qtyReturned",
        sl.unit_price_minor::bigint  AS "unitPriceMinor",
        sl.unit_cost_minor_at_sale::bigint AS "unitCostMinorAtSale",
        sl.revenue_minor::bigint     AS "revenueMinor",
        sl.cost_minor::bigint        AS "costMinor",
        sl.profit_minor::bigint      AS "profitMinor",
        sl.batch_id                  AS "batchId",
        b.is_cost_corrected          AS "batchCostCorrectedSince"
      FROM sale_lines sl
      JOIN products p ON p.id = sl.product_id
      JOIN vendors  v ON v.id = sl.vendor_id_at_sale
      JOIN quality_grades g ON g.id = sl.grade_id_at_sale
      -- Joined ONLY to flag that a correction happened. No figure is read from it.
      JOIN batches  b ON b.id = sl.batch_id
      WHERE sl.sale_id = ${saleId}
      ORDER BY sl.id
    `),
  );

  const header = headerRows[0];
  return {
    ...header,
    soldAt: new Date(header.soldAt),
    revenueMinor: Number(header.revenueMinor),
    costMinor: Number(header.costMinor),
    profitMinor: Number(header.profitMinor),
    lines: lines.map((l) => ({
      ...l,
      quantity: Number(l.quantity),
      qtyReturned: Number(l.qtyReturned),
      unitPriceMinor: Number(l.unitPriceMinor),
      unitCostMinorAtSale: Number(l.unitCostMinorAtSale),
      revenueMinor: Number(l.revenueMinor),
      costMinor: Number(l.costMinor),
      profitMinor: Number(l.profitMinor),
    })),
  };
}

export type MarginGroupBy = "vendor" | "grade" | "product";

export type MarginRow = {
  key: string;
  label: string;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  /** Profit as a percentage of revenue, to one decimal. Null when revenue is zero. */
  marginPercent: number | null;
  unitsSold: number;
};

/**
 * Margin grouped by vendor, grade, or product (FR-037).
 *
 * Grouped on the FROZEN attribution, so "which vendor's stock actually earns?" is answered with
 * the vendor those units came from at the time, even if the batch has since been edited.
 *
 * Returned units are netted out pro-rata rather than excluded: a line that was half returned
 * earned half its profit, and dropping it entirely would overstate the remaining lines' share.
 */
export async function computeMarginReport(
  dbx: Executor,
  params: { groupBy: MarginGroupBy; from?: Date | null; to?: Date | null },
): Promise<MarginRow[]> {
  const from = params.from ?? null;
  const to = params.to ?? null;

  const grouping = {
    vendor: { key: sql`v.id::text`, label: sql`v.name` },
    grade: { key: sql`g.id::text`, label: sql`g.code || ' — ' || g.label` },
    product: { key: sql`p.id::text`, label: sql`p.code || ' — ' || p.name` },
  }[params.groupBy];

  const result = rows<MarginRow>(
    await dbx.execute(sql`
      SELECT
        ${grouping.key}   AS "key",
        ${grouping.label} AS "label",
        SUM(sl.revenue_minor
            - (sl.revenue_minor / sl.quantity) * sl.qty_returned)::bigint AS "revenueMinor",
        SUM(sl.cost_minor
            - (sl.cost_minor / sl.quantity) * sl.qty_returned)::bigint    AS "costMinor",
        SUM(sl.profit_minor
            - ((sl.revenue_minor / sl.quantity) - (sl.cost_minor / sl.quantity))
              * sl.qty_returned)::bigint                                   AS "profitMinor",
        SUM(sl.quantity - sl.qty_returned)::bigint                         AS "unitsSold"
      FROM sale_lines sl
      JOIN sales s     ON s.id = sl.sale_id
      JOIN products p  ON p.id = sl.product_id
      JOIN vendors v   ON v.id = sl.vendor_id_at_sale
      JOIN quality_grades g ON g.id = sl.grade_id_at_sale
      WHERE s.status <> 'voided'
        AND s.sold_at >= COALESCE(${from}::timestamptz, '-infinity'::timestamptz)
        AND s.sold_at <  COALESCE(${to}::timestamptz,   'infinity'::timestamptz)
      GROUP BY ${grouping.key}, ${grouping.label}
      HAVING SUM(sl.quantity - sl.qty_returned) > 0
      ORDER BY 5 DESC
    `),
  );

  return result.map((r) => {
    const revenueMinor = Number(r.revenueMinor);
    const costMinor = Number(r.costMinor);
    const profitMinor = Number(r.profitMinor);
    return {
      key: String(r.key),
      label: String(r.label),
      revenueMinor,
      costMinor,
      profitMinor,
      // Null rather than zero when revenue is zero: "0% margin" and "no sales" are different
      // facts, and showing the former for the latter is a lie the owner would act on.
      marginPercent:
        revenueMinor === 0 ? null : Math.round((profitMinor / revenueMinor) * 1000) / 10,
      unitsSold: Number(r.unitsSold),
    };
  });
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
