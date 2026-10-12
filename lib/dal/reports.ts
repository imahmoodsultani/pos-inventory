import "server-only";

/**
 * Authenticated entry points for the reports (T090, T091).
 *
 * The queries live in ./reports-query.ts, pool-free and executor-taking. This file adds the
 * owner check and nothing else — every figure in these reports is cost and margin data.
 */

import { db } from "@/lib/db";
import { requireOwner } from "@/lib/dal/session";
import {
  computeMarginReport,
  computeSaleDetail,
  type MarginGroupBy,
  type MarginRow,
  type SaleDetail,
} from "./reports-query";

export type { MarginGroupBy, MarginRow, SaleDetail };

/** FR-038 — full per-line attribution as recorded AT THE TIME OF SALE. */
export async function getSaleDetail(params: { saleId: number }): Promise<SaleDetail | null> {
  await requireOwner();
  return computeSaleDetail(db, params.saleId);
}

/** FR-037 — revenue, cost, profit and margin by vendor, grade, or product. */
export async function getMarginReport(params: {
  groupBy: MarginGroupBy;
  from?: Date | null;
  to?: Date | null;
}): Promise<MarginRow[]> {
  await requireOwner();
  return computeMarginReport(db, params);
}
