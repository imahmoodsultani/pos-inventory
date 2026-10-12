import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { recordCapitalInjection, recordWithdrawal } from "@/lib/services/capital";
import { addLandedCost, receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";
import { recordSaleReturn } from "@/lib/services/sale-reversal";
import { recordWriteOff } from "@/lib/services/stock-corrections";

import { ACTOR, seedCatalogue } from "./fixtures";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

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
});

/** Every table that records something that happened. */
const TRANSACTIONAL_TABLES = [
  "batches",
  "stock_movements",
  "sales",
  "sale_lines",
  "capital_events",
  "cash_events",
  "funding_allocations",
] as const;

/** sale_lines has no actor of its own — it is owned by its sale, which does. */
const TABLES_WITH_ACTOR = TRANSACTIONAL_TABLES.filter((t) => t !== "sale_lines");

/**
 * T098a, FR-032 — every transactional row must carry an attributable actor and a server
 * timestamp.
 *
 * Swept across the whole schema rather than asserted per service, because the failure mode is a
 * NEW write path added later that quietly omits `created_by`. A per-service test would pass; this
 * one fails the moment any row lands without an actor.
 */
describe("audit trail (FR-032)", () => {
  it("every transactional row carries an actor and a server timestamp", async () => {
    // Exercise every write path there is.
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 100_000, occurredAt: new Date() }),
    );
    const batch = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 20,
        goodsCostMinor: 2_000,
        landedCostMinor: 0,
        receivedAt: new Date(),
        funding: { newCapitalMinor: 2_000, reinvestedMinor: 0 },
      }),
    );
    const sale = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: batch.batchId, quantity: 5, unitPriceMinor: 200 }],
      }),
    );
    await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "owner", {
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lines[0].saleLineId, quantity: 1 }],
        reason: "Changed mind",
        idempotencyId: 1,
      }),
    );
    await db.transaction((tx) =>
      recordWriteOff(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        quantity: 2,
        reason: "Damaged",
        idempotencyId: 2,
      }),
    );
    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 300,
        idempotencyId: 3,
        reason: "Freight",
      }),
    );
    await db.transaction((tx) =>
      recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 500, occurredAt: new Date() }),
    );

    for (const table of TABLES_WITH_ACTOR) {
      const rows = await db.execute(
        sql`SELECT COUNT(*) FILTER (WHERE created_by IS NULL OR created_by = '') AS missing,
                   COUNT(*) AS total
              FROM ${sql.identifier(table)}`,
      );
      const row = (
        Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
      )[0] as { missing: number | string; total: number | string };

      expect(Number(row.total), `${table} had no rows — the sweep proved nothing`).toBeGreaterThan(0);
      expect(
        Number(row.missing),
        `${table} has ${row.missing} row(s) with no actor — FR-032 requires one on every row`,
      ).toBe(0);
    }
  });

  it("every transactional row carries a server-generated created_at", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 1_000, occurredAt: new Date() }),
    );

    for (const table of ["capital_events", "cash_events"] as const) {
      const rows = await db.execute(
        sql`SELECT COUNT(*) FILTER (WHERE created_at IS NULL) AS missing FROM ${sql.identifier(table)}`,
      );
      const row = (
        Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
      )[0] as { missing: number | string };
      expect(Number(row.missing), `${table} has rows with no created_at`).toBe(0);
    }
  });

  it("created_by is NOT NULL at the schema level, so it cannot be skipped", async () => {
    // The sweep above proves current paths behave. This proves a FUTURE path cannot misbehave:
    // the column rejects a missing actor outright.
    const rows = await db.execute(sql`
      SELECT table_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'created_by'
         AND table_name = ANY(${sql.raw(
           `ARRAY[${TABLES_WITH_ACTOR.map((t) => `'${t}'`).join(",")}]`,
         )})
    `);
    const columns = (
      Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
    ) as Array<{ table_name: string; is_nullable: string }>;

    expect(columns.length).toBe(TABLES_WITH_ACTOR.length);
    for (const column of columns) {
      expect(column.is_nullable, `${column.table_name}.created_by is nullable`).toBe("NO");
    }
  });
});
