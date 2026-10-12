import "server-only";

/**
 * The three invariants (T034, data-model.md §12).
 *
 * These are not tests. They are the definition of the system being correct, asserted at the end
 * of every integration test AND nightly in cron. If any of them fails in production, the ledger
 * is lying and the owner is making decisions on false numbers.
 */

import { sql } from "drizzle-orm";
import type { Database, Tx } from "@/lib/db";

type Executor = Database | Tx;

export type InvariantResult = {
  name: string;
  holds: boolean;
  detail: string;
};

/**
 * Invariant A — ledger reconciliation (Constitution Principle II).
 *
 * `batches.qty_remaining` is a denormalised cache, permitted ONLY because it is reconstructible
 * from the append-only movement ledger. This query is that proof. It must return zero rows.
 */
export async function checkInvariantA(dbx: Executor): Promise<InvariantResult> {
  const rows = await dbx.execute<{ id: number; cached: number; derived: number }>(sql`
    SELECT b.id,
           b.qty_remaining AS cached,
           COALESCE(SUM(m.qty_delta), 0) AS derived
      FROM batches b
      LEFT JOIN stock_movements m ON m.batch_id = b.id
     GROUP BY b.id, b.qty_remaining
    HAVING b.qty_remaining <> COALESCE(SUM(m.qty_delta), 0)
  `);
  const bad = rowsOf<{ id: number; cached: number; derived: number }>(rows);
  return {
    name: "A: qty_remaining reconstructs from stock_movements",
    holds: bad.length === 0,
    detail:
      bad.length === 0
        ? "all batches reconcile"
        : `${bad.length} batch(es) drifted: ` +
          bad
            .slice(0, 5)
            .map((r) => `#${r.id} cached=${r.cached} derived=${r.derived}`)
            .join(", "),
  };
}

export type IdentityFigures = {
  capitalInvestedMinor: number;
  capitalRecoveredMinor: number;
  profitToDateMinor: number;
  cashOnHandMinor: number;
  inventoryAtCostMinor: number;
  lhs: number;
  rhs: number;
};

/**
 * Invariant B — the accounting identity (SC-003), exact to the minor unit:
 *
 *     capital_invested - capital_recovered + profit_to_date = cash_on_hand + inventory_at_cost
 *
 * Capital invested is injections ONLY. Defining it as injections plus the new-capital portion of
 * each purchase double-counts every injection the moment it is spent, and breaks this identity on
 * the very first purchase (FR-026a, FR-033a).
 *
 * Inventory is valued with each batch's CURRENT total_cost_minor via the same prefix-difference
 * allocation the sale path uses, so a late landed cost moves inventory and profit together.
 */
export async function computeIdentity(dbx: Executor): Promise<IdentityFigures> {
  const result = await dbx.execute<IdentityFigures>(sql`
    WITH
    capital AS (
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'injection'), 0)  AS invested,
        COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'withdrawal'), 0) AS recovered
      FROM capital_events
    ),
    cash AS (
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'in'), 0)
      - COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'out'), 0) AS on_hand
      FROM cash_events
    ),
    /*
     * Gross trading profit (FR-035): sale line profit, LESS the profit reversed by returns and
     * voids, less write-offs, less cost-correction adjustments.
     *
     * The reversal term is not optional and is easy to miss. A return does NOT rewrite the
     * sale line - the line keeps recording what was sold, and qty_returned records how much
     * came back. Summing profit_minor alone therefore credits a fully-voided sale with its
     * full profit forever, while the cash has gone back out and the stock has returned: the
     * identity then fails by exactly that amount.
     *
     * Reversed per unit with integer division, matching the pro-rata arithmetic in
     * sale-reversal.ts, so the two cannot disagree by a rounding step.
     */
    sale_profit AS (
      SELECT COALESCE(SUM(
               profit_minor
               - ((revenue_minor / quantity) - (cost_minor / quantity)) * qty_returned
             ), 0) AS total
        FROM sale_lines
    ),
    adjustments AS (
      SELECT COALESCE(SUM(cost_minor), 0) AS total
        FROM stock_movements
       WHERE movement_type IN ('write_off', 'adjustment')
    ),
    -- Value of units still on the shelf, using the SAME floor(T*k/N) allocation as the sale
    -- path. Cost of units (consumed, qty_received] = T - floor(T*consumed/N).
    inventory AS (
      SELECT COALESCE(SUM(
               total_cost_minor
               - (total_cost_minor * (qty_received - qty_remaining)) / qty_received
             ), 0) AS at_cost
        FROM batches
       WHERE qty_remaining > 0
    )
    SELECT
      capital.invested::bigint      AS "capitalInvestedMinor",
      capital.recovered::bigint     AS "capitalRecoveredMinor",
      (sale_profit.total - adjustments.total)::bigint AS "profitToDateMinor",
      cash.on_hand::bigint          AS "cashOnHandMinor",
      inventory.at_cost::bigint     AS "inventoryAtCostMinor",
      (capital.invested - capital.recovered + sale_profit.total - adjustments.total)::bigint AS lhs,
      (cash.on_hand + inventory.at_cost)::bigint AS rhs
    FROM capital, cash, sale_profit, adjustments, inventory
  `);
  return rowsOf<IdentityFigures>(result)[0];
}

export async function checkInvariantB(dbx: Executor): Promise<InvariantResult> {
  const f = await computeIdentity(dbx);
  const holds = f.lhs === f.rhs;
  return {
    name: "B: capital - recovered + profit = cash + inventory",
    holds,
    detail: holds
      ? `balanced at ${f.lhs}`
      : `OFF BY ${f.lhs - f.rhs}. invested=${f.capitalInvestedMinor} ` +
        `recovered=${f.capitalRecoveredMinor} profit=${f.profitToDateMinor} ` +
        `cash=${f.cashOnHandMinor} inventory=${f.inventoryAtCostMinor}`,
  };
}

/**
 * Invariant C — cost allocation closure (FR-007, FR-007a).
 *
 * For a FULLY DEPLETED batch, every minor unit of its cost must have been attributed to some
 * OUTBOUND movement: sales, write-offs, vendor returns, and any FR-007a correction adjustments
 * together sum to total_cost_minor. The "fully depleted" qualifier is load-bearing — a partly
 * sold batch has only its consumed portion attributed, by design.
 *
 * The `receipt` row is EXCLUDED. It carries the batch's full cost as the inbound side of the
 * ledger, so counting it alongside the outbound rows yields 2 × total for every depleted batch.
 * The first version of this query did exactly that; it passed on an empty database and on every
 * partly-sold batch, and only failed once something depleted — which is precisely the kind of
 * invariant that is worthless if it is wrong, because it is trusted.
 */
export async function checkInvariantC(dbx: Executor): Promise<InvariantResult> {
  const rows = await dbx.execute<{ id: number; allocated: number; total: number }>(sql`
    SELECT b.id,
           COALESCE(SUM(m.cost_minor) FILTER (WHERE m.movement_type <> 'receipt'), 0) AS allocated,
           b.total_cost_minor AS total
      FROM batches b
      JOIN stock_movements m ON m.batch_id = b.id
     WHERE b.qty_remaining = 0
     GROUP BY b.id, b.total_cost_minor
    HAVING COALESCE(SUM(m.cost_minor) FILTER (WHERE m.movement_type <> 'receipt'), 0)
           <> b.total_cost_minor
  `);
  const bad = rowsOf<{ id: number; allocated: number; total: number }>(rows);
  return {
    name: "C: depleted batch costs sum to total_cost_minor",
    holds: bad.length === 0,
    detail:
      bad.length === 0
        ? "all depleted batches close"
        : `${bad.length} batch(es) leaked cost: ` +
          bad
            .slice(0, 5)
            .map((r) => `#${r.id} allocated=${r.allocated} total=${r.total}`)
            .join(", "),
  };
}

export async function checkAllInvariants(dbx: Executor): Promise<InvariantResult[]> {
  return [
    await checkInvariantA(dbx),
    await checkInvariantB(dbx),
    await checkInvariantC(dbx),
  ];
}

/** drizzle's execute() returns either an array or a pg QueryResult depending on the driver. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
