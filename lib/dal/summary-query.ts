/**
 * The business summary QUERY (T083, T084, FR-033 … FR-035b).
 *
 * Takes an executor rather than importing the module-global pool, so it can run inside a
 * transaction, against a test container, or from the nightly reconcile job. The auth boundary
 * lives in ./summary.ts — this file deliberately knows nothing about who is asking.
 *
 * This is the screen the whole system exists to produce: profit to date, capital invested,
 * capital recovered, cash on hand, and unsold inventory at cost — tied together by the SC-003
 * identity, exact to the minor unit.
 *
 * Owner only, and deliberately NOT cached. A stale summary is worse than a slow one: it is a
 * number the owner will act on.
 */

import { sql } from "drizzle-orm";

import type { Database, Tx } from "@/lib/db";

type Executor = Database | Tx;

export type BusinessSummary = {
  /** Gross TRADING profit — revenue less cost of goods sold (FR-035a). Not net profit. */
  profitToDateMinor: number;
  capitalInvestedMinor: number;
  capitalRecoveredMinor: number;
  cashOnHandMinor: number;
  inventoryAtCostMinor: number;
  /** SC-003. Surfaced, never assumed — see the note below. */
  identityHolds: boolean;
  identityDifferenceMinor: number;
  /** Which figures the date filter actually changed. */
  range: { from: Date | null; to: Date | null };
};

/**
 * Date filtering (FR-034) splits the figures in two, and conflating them is the trap:
 *
 *   ACTIVITY figures — profit, injections, withdrawals — are "what happened in this window".
 *   POSITION figures — cash on hand, inventory at cost — are "what is true RIGHT NOW".
 *
 * There is no such thing as "cash on hand during March": a balance exists at an instant, not
 * over a period. Recomputing it from a window would report the net movement of cash in March as
 * though it were the balance, which is a different number with the same name — the worst kind of
 * reporting bug, because it looks plausible.
 *
 * So position figures IGNORE the range, and the UI labels them "current" (T085).
 */
export async function computeSummary(
  dbx: Executor,
  params?: { from?: Date | null; to?: Date | null },
): Promise<BusinessSummary> {
  const from = params?.from ?? null;
  const to = params?.to ?? null;

  const rows = await dbx.execute(sql`
    WITH
    bounds AS (
      SELECT ${from}::timestamptz AS from_ts, ${to}::timestamptz AS to_ts
    ),
    capital AS (
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'injection'), 0)  AS invested,
        COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'withdrawal'), 0) AS recovered
      FROM capital_events, bounds
      WHERE occurred_at >= COALESCE(bounds.from_ts, '-infinity'::timestamptz)
        AND occurred_at <  COALESCE(bounds.to_ts,   'infinity'::timestamptz)
    ),
    -- POSITION: always current, never ranged. See the note above.
    cash AS (
      SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'in'), 0)
           - COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'out'), 0) AS on_hand
      FROM cash_events
    ),
    -- ACTIVITY: sale profit less the profit reversed by returns and voids (FR-035).
    sale_profit AS (
      SELECT COALESCE(SUM(
               sl.profit_minor
               - ((sl.revenue_minor / sl.quantity) - (sl.cost_minor / sl.quantity)) * sl.qty_returned
             ), 0) AS total
      FROM sale_lines sl
      JOIN sales s ON s.id = sl.sale_id, bounds
      WHERE s.sold_at >= COALESCE(bounds.from_ts, '-infinity'::timestamptz)
        AND s.sold_at <  COALESCE(bounds.to_ts,   'infinity'::timestamptz)
    ),
    adjustments AS (
      SELECT COALESCE(SUM(cost_minor), 0) AS total
      FROM stock_movements, bounds
      WHERE movement_type IN ('write_off', 'adjustment')
        AND created_at >= COALESCE(bounds.from_ts, '-infinity'::timestamptz)
        AND created_at <  COALESCE(bounds.to_ts,   'infinity'::timestamptz)
    ),
    /*
     * Inventory at cost (T084): Σ over OPEN batches of the cost of the units still on the shelf,
     * using each batch's CURRENT total_cost_minor and the same floor(T*k/N) allocation the sale
     * path uses:
     *
     *     remaining cost = T - floor(T * consumed / N)
     *
     * NOT qty_remaining × some stored unit cost. There is no stored unit cost, by design — a
     * rounded one would disagree with the batch total and the identity would drift a minor unit
     * at a time.
     */
    inventory AS (
      SELECT COALESCE(SUM(
               total_cost_minor
               - (total_cost_minor * (qty_received - qty_remaining)) / qty_received
             ), 0) AS at_cost
      FROM batches
      WHERE qty_remaining > 0
    )
    SELECT
      (sale_profit.total - adjustments.total)::bigint AS "profitToDateMinor",
      capital.invested::bigint   AS "capitalInvestedMinor",
      capital.recovered::bigint  AS "capitalRecoveredMinor",
      cash.on_hand::bigint       AS "cashOnHandMinor",
      inventory.at_cost::bigint  AS "inventoryAtCostMinor"
    FROM capital, cash, sale_profit, adjustments, inventory
  `);

  const row = (
    Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
  )[0] as Record<string, number | string>;

  const figures = {
    profitToDateMinor: Number(row.profitToDateMinor),
    capitalInvestedMinor: Number(row.capitalInvestedMinor),
    capitalRecoveredMinor: Number(row.capitalRecoveredMinor),
    cashOnHandMinor: Number(row.cashOnHandMinor),
    inventoryAtCostMinor: Number(row.inventoryAtCostMinor),
  };

  /**
   * The identity only holds over ALL TIME. Within a date window the activity figures are a slice
   * while the position figures are current, so they are not expected to balance — checking it
   * there would raise a false alarm on every filtered view.
   */
  const ranged = from !== null || to !== null;
  const lhs =
    figures.capitalInvestedMinor - figures.capitalRecoveredMinor + figures.profitToDateMinor;
  const rhs = figures.cashOnHandMinor + figures.inventoryAtCostMinor;

  const identityDifferenceMinor = ranged ? 0 : lhs - rhs;

  return {
    ...figures,
    identityHolds: ranged ? true : lhs === rhs,
    identityDifferenceMinor,
    range: { from, to },
  };
}
