/**
 * Ensure the E2E run has stock to sell.
 *
 * The till test consumes three units every run, against a shared development database. Left
 * alone it drains the batch and starts failing after a handful of runs — a test that passes only
 * until you run it enough times is worse than one that never passed, because the failure looks
 * like a regression in the code.
 *
 * This records a genuine receipt each run (capital in, batch, movement, funding, cash out) rather
 * than UPDATEing qty_remaining, so the ledger stays internally consistent and the invariants
 * continue to hold.
 */

import { Pool } from "pg";

import { readEnvLocal } from "./env";

const TOP_UP_THRESHOLD = 25;
const TOP_UP_QTY = 200;
const TOP_UP_COST_MINOR = 20_000; // 100 per unit

export default async function globalSetup(): Promise<void> {
  const connectionString = readEnvLocal().DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL missing from .env.local");

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ available: string }>(
      "SELECT COALESCE(SUM(qty_remaining), 0) AS available FROM batches",
    );
    if (Number(rows[0].available) >= TOP_UP_THRESHOLD) return;

    const catalogue = await pool.query<{ product: number; vendor: number; grade: number }>(`
      SELECT
        (SELECT id FROM products       WHERE is_active ORDER BY id LIMIT 1) AS product,
        (SELECT id FROM vendors        WHERE is_active ORDER BY id LIMIT 1) AS vendor,
        (SELECT id FROM quality_grades WHERE is_active ORDER BY id LIMIT 1) AS grade
    `);
    const { product, vendor, grade } = catalogue.rows[0] ?? {};
    if (!product || !vendor || !grade) {
      throw new Error(
        "No active product/vendor/grade. Run: npx dotenv -e .env.local -- npx tsx scripts/seed.ts",
      );
    }

    await pool.query("BEGIN");

    // Fund it, so the purchase does not drive cash negative.
    const capital = await pool.query<{ id: number }>(
      `INSERT INTO capital_events (event_type, amount_minor, occurred_at, created_by)
       VALUES ('injection', $1, now(), 'e2e-setup') RETURNING id`,
      [TOP_UP_COST_MINOR],
    );
    await pool.query(
      `INSERT INTO cash_events (direction, amount_minor, source_type, source_id, occurred_at, created_by)
       VALUES ('in', $1, 'capital_injection', $2, now(), 'e2e-setup')`,
      [TOP_UP_COST_MINOR, capital.rows[0].id],
    );

    const batch = await pool.query<{ id: number; total: number }>(
      `INSERT INTO batches
         (product_id, vendor_id, grade_id, received_at, qty_received, qty_remaining,
          goods_cost_minor, landed_cost_minor, created_by)
       VALUES ($1, $2, $3, now(), $4, $4, $5, 0, 'e2e-setup')
       RETURNING id, total_cost_minor AS total`,
      [product, vendor, grade, TOP_UP_QTY, TOP_UP_COST_MINOR],
    );
    const batchId = batch.rows[0].id;

    await pool.query(
      `INSERT INTO stock_movements
         (batch_id, movement_type, qty_delta, cost_minor, ref_type, ref_id, created_by)
       VALUES ($1, 'receipt', $2, $3, 'batch', $1, 'e2e-setup')`,
      [batchId, TOP_UP_QTY, batch.rows[0].total],
    );
    await pool.query(
      `INSERT INTO funding_allocations (batch_id, new_capital_minor, reinvested_minor, created_by)
       VALUES ($1, $2, 0, 'e2e-setup')`,
      [batchId, batch.rows[0].total],
    );
    await pool.query(
      `INSERT INTO cash_events (direction, amount_minor, source_type, source_id, occurred_at, created_by)
       VALUES ('out', $1, 'purchase_payment', $2, now(), 'e2e-setup')`,
      [batch.rows[0].total, batchId],
    );

    await pool.query("COMMIT");
    console.log(`[e2e setup] topped up with ${TOP_UP_QTY} units (batch ${batchId})`);
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}
