import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { computeSummary } from "@/lib/dal/summary-query";
import { computeMarginReport } from "@/lib/dal/reports-query";

import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});

const PRODUCTS = 2_000;
const VENDORS = 200;
const MOVEMENTS = 50_000;
const BUDGET_MS = 3_000;

/**
 * T082 / SC-009 — the summary and stock reports must return in under 3 seconds at
 * 2,000 products, 200 vendors, and 50,000 stock movements.
 *
 * Seeded with bulk SQL rather than through the services: this test is about QUERY behaviour at
 * volume, and routing 50,000 movements through the transactional path would take minutes while
 * proving nothing extra about the reads.
 *
 * The thing this catches is a query that is fine on the dozen rows every other test uses and
 * quietly degrades as a real year of trading accumulates — the worst kind of regression, because
 * nothing fails, it just gets slower until someone complains.
 */
describe("US4 — report performance at scale (SC-009)", () => {
  beforeAll(async () => {
    await truncateAll();

    await db.execute(sql`
      INSERT INTO vendors (name, created_by)
      SELECT 'Vendor ' || g, 'scale-seed' FROM generate_series(1, ${VENDORS}) g
    `);
    await db.execute(sql`
      INSERT INTO quality_grades (code, label, sort_order, created_by)
      SELECT 'G' || g, 'Grade ' || g, g, 'scale-seed' FROM generate_series(1, 5) g
    `);
    await db.execute(sql`
      INSERT INTO products (code, name, unit_of_measure, created_by)
      SELECT 'SKU-' || g, 'Product ' || g, 'piece', 'scale-seed'
        FROM generate_series(1, ${PRODUCTS}) g
    `);

    // Fund everything, then one batch per product.
    await db.execute(sql`
      INSERT INTO capital_events (event_type, amount_minor, occurred_at, created_by)
      VALUES ('injection', 100000000000, now(), 'scale-seed')
    `);
    await db.execute(sql`
      INSERT INTO cash_events (direction, amount_minor, source_type, source_id, occurred_at, created_by)
      SELECT 'in', 100000000000, 'capital_injection', id, now(), 'scale-seed' FROM capital_events
    `);

    await db.execute(sql`
      INSERT INTO batches (product_id, vendor_id, grade_id, received_at, qty_received,
                           qty_remaining, goods_cost_minor, landed_cost_minor, created_by)
      SELECT p.id,
             ((p.id % ${VENDORS}) + 1),
             ((p.id % 5) + 1),
             now() - (p.id || ' hours')::interval,
             100, 100, 10000, 0, 'scale-seed'
        FROM products p
    `);
    await db.execute(sql`
      INSERT INTO funding_allocations (batch_id, new_capital_minor, reinvested_minor, created_by)
      SELECT id, total_cost_minor, 0, 'scale-seed' FROM batches
    `);
    await db.execute(sql`
      INSERT INTO cash_events (direction, amount_minor, source_type, source_id, occurred_at, created_by)
      SELECT 'out', total_cost_minor, 'purchase_payment', id, now(), 'scale-seed' FROM batches
    `);
    await db.execute(sql`
      INSERT INTO stock_movements (batch_id, movement_type, qty_delta, cost_minor,
                                   ref_type, ref_id, created_by)
      SELECT id, 'receipt', qty_received, total_cost_minor, 'batch', id, 'scale-seed' FROM batches
    `);

    /**
     * Pad the movement ledger to 50,000 rows with sale/sale_return PAIRS that net to zero on
     * every batch, so qty_remaining still reconciles and the volume is realistic rather than a
     * ledger that is internally broken and therefore unrepresentative.
     *
     * Parity comes from the ROUND number, not from g.
     *
     * The obvious `CASE WHEN g % 2 = 0` is wrong here and Invariant A caught it: with
     * batch = (g % PRODUCTS) + 1, every row belonging to one batch shares g's parity, so each
     * batch received 24 sales or 24 returns and none received both. Deriving direction from
     * floor((g-1)/PRODUCTS) alternates per pass over the batches instead, giving each batch an
     * equal number of each.
     */
    const padding = MOVEMENTS - PRODUCTS;
    await db.execute(sql`
      INSERT INTO stock_movements (batch_id, movement_type, qty_delta, cost_minor,
                                   reason, ref_type, ref_id, created_by)
      SELECT ((g - 1) % ${PRODUCTS}) + 1,
             CASE WHEN ((g - 1) / ${PRODUCTS}) % 2 = 0 THEN 'sale' ELSE 'sale_return' END,
             CASE WHEN ((g - 1) / ${PRODUCTS}) % 2 = 0 THEN -1 ELSE 1 END,
             CASE WHEN ((g - 1) / ${PRODUCTS}) % 2 = 0 THEN 100 ELSE -100 END,
             'scale padding',
             'stock_count',
             1000000 + g,
             'scale-seed'
        FROM generate_series(1, ${padding}) g
    `);

    await db.execute(sql`ANALYZE`);
  }, 600_000);

  it(`seeded the stated volume`, async () => {
    const counts = await db.execute(sql`
      SELECT (SELECT COUNT(*) FROM products) AS products,
             (SELECT COUNT(*) FROM vendors) AS vendors,
             (SELECT COUNT(*) FROM stock_movements) AS movements
    `);
    const row = (
      Array.isArray(counts) ? counts : ((counts as unknown as { rows: unknown[] }).rows ?? [])
    )[0] as Record<string, string>;

    // Asserted, because a performance test against an empty table is a test that always passes.
    expect(Number(row.products)).toBe(PRODUCTS);
    expect(Number(row.vendors)).toBe(VENDORS);
    expect(Number(row.movements)).toBe(MOVEMENTS);
  });

  it(`the summary returns in under ${BUDGET_MS}ms`, async () => {
    const started = performance.now();
    const summary = await computeSummary(db);
    const elapsed = performance.now() - started;

    console.log(`summary at scale: ${elapsed.toFixed(0)}ms`);
    expect(summary.inventoryAtCostMinor).toBeGreaterThan(0);
    expect(elapsed, `summary took ${elapsed.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it(`the stock-on-hand query returns in under ${BUDGET_MS}ms`, async () => {
    // The DAL wrapper requires a session; this is the same query it runs.
    const started = performance.now();
    const rows = await db.execute(sql`
      SELECT b.id, p.code, p.name, v.name AS vendor, g.code AS grade,
             b.qty_received, b.qty_remaining, b.received_at, b.total_cost_minor
        FROM batches b
        JOIN products p ON p.id = b.product_id
        JOIN vendors v ON v.id = b.vendor_id
        JOIN quality_grades g ON g.id = b.grade_id
       WHERE b.qty_remaining > 0
       ORDER BY p.name, b.received_at, b.id
    `);
    const elapsed = performance.now() - started;
    const count = (Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? []))
      .length;

    console.log(`stock on hand at scale: ${elapsed.toFixed(0)}ms for ${count} batches`);
    expect(count).toBe(PRODUCTS);
    expect(elapsed, `stock query took ${elapsed.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it(`the margin report returns in under ${BUDGET_MS}ms`, async () => {
    const started = performance.now();
    await computeMarginReport(db, { groupBy: "vendor" });
    const elapsed = performance.now() - started;
    console.log(`margin report at scale: ${elapsed.toFixed(0)}ms`);
    expect(elapsed, `margin report took ${elapsed.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("the nightly reconciliation completes in reasonable time at this volume", async () => {
    const { checkAllInvariants } = await import("@/lib/dal/invariants");
    const started = performance.now();
    const results = await checkAllInvariants(db);
    const elapsed = performance.now() - started;

    console.log(`invariants at scale: ${elapsed.toFixed(0)}ms`);
    // Invariant A joins every movement to its batch — the one most likely to degrade.
    expect(results.every((r) => r.holds), results.map((r) => r.detail).join("; ")).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
