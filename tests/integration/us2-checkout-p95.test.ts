import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});

const ITERATIONS = 200;
const P95_BUDGET_MS = 1000;

/**
 * T070a — the constitution's checkout budget: "the primary add item → tender → complete sale
 * path MUST respond within 1 second at p95".
 *
 * SC-006's 60-second figure measures a HUMAN completing a sale and does not constrain the
 * server at all; a 900ms action would pass it comfortably while making the till feel broken.
 * This measures the server-side work only.
 *
 * Measured at the SC-009 data volume, because a p95 taken against three rows proves nothing:
 * the batch picker's index and the sale-number MAX scan both degrade with table size, and that
 * degradation is exactly what this is here to catch.
 */
describe("US2 — checkout latency (constitution: p95 < 1s)", () => {
  it(`keeps recordSale under ${P95_BUDGET_MS}ms at p95 over ${ITERATIONS} sales`, async () => {
    await truncateAll();
    const cat = await seedCatalogue(db);
    await injectCapital(db, 500_000_000);

    // Build a realistic catalogue: enough products and batches that indexes matter.
    const extraProducts: number[] = [cat.product];
    const rows = await db
      .insert(products)
      .values(
        Array.from({ length: 199 }, (_, i) => ({
          code: `SKU-${String(i).padStart(4, "0")}`,
          name: `Product ${i}`,
          unitOfMeasure: "piece",
          createdBy: ACTOR,
        })),
      )
      .returning({ id: products.id });
    extraProducts.push(...rows.map((r) => r.id));

    // One deep batch per product, plus a tall stack on the product under test so the sales
    // never run out and never trivially hit an empty picker.
    const batchIds: number[] = [];
    for (const productId of extraProducts) {
      const r = await db.transaction((tx) =>
        receiveStock(tx as Tx, ACTOR, {
          productId,
          vendorId: cat.vendorA,
          gradeId: cat.gradeA,
          qtyReceived: 1000,
          goodsCostMinor: 100_000,
          landedCostMinor: 0,
          receivedAt: new Date(),
          funding: { newCapitalMinor: 100_000, reinvestedMinor: 0 },
        }),
      );
      batchIds.push(r.batchId);
    }

    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // Two lines from different batches — a realistic basket, and the shape the E2E test uses.
      const a = batchIds[i % batchIds.length];
      const b = batchIds[(i + 1) % batchIds.length];

      const started = performance.now();
      await db.transaction((tx) =>
        recordSale(tx as Tx, ACTOR, {
          paymentMethod: "cash",
          lines: [
            { batchId: a, quantity: 1, unitPriceMinor: 150 },
            { batchId: b, quantity: 2, unitPriceMinor: 120 },
          ],
        }),
      );
      durations.push(performance.now() - started);
    }

    // Keep execution order for the drift check before sorting for percentiles.
    const ordered = [...durations];
    durations.sort((x, y) => x - y);
    const at = (q: number) => durations[Math.min(durations.length - 1, Math.floor(q * durations.length))];

    const p50 = at(0.5);
    const p95 = at(0.95);
    const p99 = at(0.99);

    // Reported unconditionally: a budget nobody can see the headroom on is a budget that gets
    // breached silently by the change after next.
    console.log(
      `recordSale over ${ITERATIONS} sales — ` +
        `p50 ${p50.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, p99 ${p99.toFixed(1)}ms, ` +
        `max ${durations[durations.length - 1].toFixed(1)}ms`,
    );

    /**
     * DRIFT CHECK, in execution order rather than sorted.
     *
     * A p95 inside budget can still hide a cost that GROWS with the number of sales — and a
     * till that is fast in testing and slow after a year of trading is the worst possible
     * outcome, because nothing flags it. Comparing the first and last tenth separates "a few
     * slow outliers" (fine: a checkpoint, a pool hiccup) from "every sale is getting slower"
     * (not fine: something is scanning the whole sales table on each write).
     */
    const slice = Math.max(10, Math.floor(ITERATIONS / 10));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const firstTenth = mean(ordered.slice(0, slice));
    const lastTenth = mean(ordered.slice(-slice));
    console.log(
      `drift — first ${slice} mean ${firstTenth.toFixed(1)}ms, ` +
        `last ${slice} mean ${lastTenth.toFixed(1)}ms, ` +
        `ratio ${(lastTenth / firstTenth).toFixed(2)}x`,
    );

    expect(
      lastTenth,
      `latency grew ${(lastTenth / firstTenth).toFixed(2)}x across the run — the per-sale cost ` +
        `scales with table size, so this will degrade in production as sales accumulate`,
    ).toBeLessThan(firstTenth * 3);

    expect(p95, `p95 ${p95.toFixed(1)}ms exceeds the ${P95_BUDGET_MS}ms budget`).toBeLessThan(
      P95_BUDGET_MS,
    );
  }, 600_000);
});
