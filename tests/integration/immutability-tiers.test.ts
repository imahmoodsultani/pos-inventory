import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { recordCapitalInjection } from "@/lib/services/capital";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

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

/**
 * What each table physically permits (data-model §6, FR-042).
 *
 * These assertions did not exist before this change. The tiers were verified by hand during the
 * original build and never captured, which meant the single most load-bearing guarantee in the
 * system — that a sale's record of what happened cannot be rewritten — rested on a trigger nobody
 * was testing.
 *
 * This file is that guarantee. The trigger definition is an implementation detail; these
 * expectations are the contract.
 */
/**
 * Assert a database write was refused with a given message.
 *
 * drizzle wraps driver errors in its own "Failed query:" text, so the trigger's message — the part
 * that says WHICH rule fired — survives only on the cause. Matching the wrapper would pass for any
 * failure at all, including a typo in the SQL.
 */
async function expectRejected(promise: Promise<unknown>, matching: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the database to reject this write").not.toBeNull();
  const cause = (error as { cause?: { message?: string } }).cause;
  const message = cause?.message ?? (error as Error).message;
  expect(message).toMatch(matching);
}

describe("immutability tiers", () => {
  async function arrange() {
    const capital = await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, {
        amountMinor: 100_000,
        occurredAt: new Date(),
      }),
    );
    const batch = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1_000,
        landedCostMinor: 0,
        receivedAt: new Date(),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
      }),
    );
    const sale = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: batch.batchId, quantity: 2, unitPriceMinor: 200 }],
      }),
    );
    return { capital, batch, sale };
  }

  describe("fully immutable", () => {
    it("stock_movements rejects UPDATE and DELETE", async () => {
      await arrange();
      await expectRejected(db.execute(sql`UPDATE stock_movements SET cost_minor = 1`), /append-only/);
      await expectRejected(db.execute(sql`DELETE FROM stock_movements`), /append-only/);
    });

    it("sale_lines and sales reject DELETE while their columns still advance", async () => {
      const { sale } = await arrange();
      await expectRejected(db.execute(sql`DELETE FROM sales`), /append-only/);
      await expectRejected(db.execute(sql`DELETE FROM sale_lines`), /append-only/);

      // status legitimately advances as returns and voids are recorded.
      await db.execute(sql`UPDATE sales SET status = 'partially_returned' WHERE id = ${sale.saleId}`);
    });
  });

  describe("capital_events — editable, never deletable (FR-042, FR-046)", () => {
    it("accepts UPDATE", async () => {
      const { capital } = await arrange();
      await db.execute(
        sql`UPDATE capital_events SET amount_minor = 5000 WHERE id = ${capital.eventId}`,
      );
      const rows = await db.execute<{ amount_minor: number }>(
        sql`SELECT amount_minor FROM capital_events WHERE id = ${capital.eventId}`,
      );
      const row = (Array.isArray(rows) ? rows : (rows as { rows: { amount_minor: number }[] }).rows)[0];
      expect(Number(row.amount_minor)).toBe(5000);
    });

    it("still rejects DELETE", async () => {
      await arrange();
      // Correcting to zero effect is the path; removing the evidence of a mistake is not.
      await expectRejected(db.execute(sql`DELETE FROM capital_events`), /append-only/);
    });
  });

  describe("cash_events — source-conditional", () => {
    it("accepts UPDATE on a capital-sourced row", async () => {
      const { capital } = await arrange();
      await db.execute(sql`
        UPDATE cash_events SET amount_minor = 5000
         WHERE source_type = 'capital_injection' AND source_id = ${capital.eventId}
      `);
    });

    it("REJECTS UPDATE on a sale's takings", async () => {
      const { sale } = await arrange();
      // The assertion that matters most in this file. A sale's recorded takings are a record of
      // what happened at the till; if they can be rewritten, nothing downstream means anything.
      await expectRejected(db.execute(sql`
          UPDATE cash_events SET amount_minor = 1
           WHERE source_type = 'sale' AND source_id = ${sale.saleId}
        `), /append-only/);
    });

    it("REJECTS UPDATE on a purchase payment", async () => {
      const { batch } = await arrange();
      await expectRejected(db.execute(sql`
          UPDATE cash_events SET amount_minor = 1
           WHERE source_type = 'purchase_payment' AND source_id = ${batch.batchId}
        `), /append-only/);
    });

    it("refuses to re-point a capital cash row at another business event", async () => {
      const { capital } = await arrange();
      // A correction adjusts an amount or a date. It never re-attaches the row to a different
      // event, which would silently move money between facts.
      await expectRejected(db.execute(sql`
          UPDATE cash_events SET source_id = 424242
           WHERE source_type = 'capital_injection' AND source_id = ${capital.eventId}
        `), /immutable/);
    });

    it("rejects DELETE regardless of source", async () => {
      await arrange();
      await expectRejected(db.execute(sql`DELETE FROM cash_events`), /append-only/);
    });
  });

  describe("record_edits — the audit log itself", () => {
    it("rejects UPDATE and DELETE", async () => {
      await db.execute(sql`
        INSERT INTO record_edits (table_name, record_id, field_name, edit_group, changed_by)
        VALUES ('vendors', '1', 'name', 'g1', ${ACTOR})
      `);
      await expectRejected(db.execute(sql`UPDATE record_edits SET new_value = 'tampered'`), /append-only/);
      await expectRejected(db.execute(sql`DELETE FROM record_edits`), /append-only/);
    });
  });
});
