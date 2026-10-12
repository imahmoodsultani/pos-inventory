import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { batches, stockMovements } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { assertInvariants } from "./invariants";
import {
  distinctConnection,
  startTestDatabase,
  stopTestDatabase,
  truncateAll,
  type TestDb,
} from "./setup";

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
  await injectCapital(db, 10_000_000);
});

async function receiveBatch(qty: number, costMinor: number): Promise<number> {
  const r = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qtyReceived: qty,
      goodsCostMinor: costMinor,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: costMinor, reinvestedMinor: 0 },
    }),
  );
  return r.batchId;
}

/**
 * A barrier that releases every participant at once.
 *
 * Without this, "concurrent" attempts are really sequential: the first await resolves before the
 * last one is even issued, the contention window never opens, and a completely broken decrement
 * would pass. The negative control at the bottom of this file is what proves the barrier works.
 */
function makeBarrier(count: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let allArrived!: () => void;
  const ready = new Promise<void>((resolve) => {
    allArrived = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived === count) allArrived();
      await gate;
    },
    ready,
    release: () => release(),
  };
}

const CONTENDERS = 8;
const REPEATS = 25;

describe("US2 — oversell is impossible (SC-007, D8)", () => {
  it(`survives ${REPEATS} rounds of ${CONTENDERS} concurrent sales of the LAST unit`, async () => {
    // Separate physical connections, created once and reused across rounds.
    const connections = await Promise.all(
      Array.from({ length: CONTENDERS }, () => distinctConnection()),
    );

    let totalSucceeded = 0;

    for (let round = 0; round < REPEATS; round++) {
      await truncateAll();
      cat = await seedCatalogue(db);
      await injectCapital(db, 1_000_000);
      const batchId = await receiveBatch(1, 100); // exactly ONE unit

      const barrier = makeBarrier(CONTENDERS);

      const attempts = connections.map((conn) =>
        (async () => {
          await barrier.wait();
          try {
            await conn.transaction((tx) =>
              recordSale(tx as Tx, ACTOR, {
                paymentMethod: "cash",
                lines: [{ batchId, quantity: 1, unitPriceMinor: 150 }],
              }),
            );
            return { ok: true as const };
          } catch (error) {
            return { ok: false as const, error };
          }
        })(),
      );

      await barrier.ready;
      barrier.release();
      const results = await Promise.all(attempts);

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      totalSucceeded += succeeded.length;

      expect(succeeded, `round ${round}: expected exactly one winner`).toHaveLength(1);

      for (const f of failed) {
        const err = f.error as { code?: string; cause?: { code?: string }; message?: string };
        /**
         * Every loser must be INSUFFICIENT_STOCK — a domain error returned as a value.
         *
         * SQLSTATE 23514 is the CHECK (qty_remaining >= 0) backstop. If it ever reaches a
         * caller, the guarded UPDATE was bypassed and the "protection" was really the
         * constraint all along, which would mean a 500 at the till instead of "only 0 left".
         */
        expect(err.cause?.code, "a CHECK violation escaped to the caller").not.toBe("23514");
        expect(String(err.message ?? "")).not.toContain("qty_remaining_sane");
        expect(err.code).toBe("INSUFFICIENT_STOCK");
      }

      const [row] = await db.select().from(batches).where(eq(batches.id, batchId));
      expect(row.qtyRemaining).toBe(0);
      expect(row.qtyRemaining).toBeGreaterThanOrEqual(0);

      const movements = await db
        .select()
        .from(stockMovements)
        .where(
          and(eq(stockMovements.batchId, batchId), eq(stockMovements.movementType, "sale")),
        );
      expect(movements, `round ${round}: exactly one sale movement`).toHaveLength(1);

      await assertInvariants(db);
    }

    expect(totalSucceeded).toBe(REPEATS);
  }, 300_000);

  /**
   * ⚠️ THE NEGATIVE CONTROL (T057).
   *
   * This runs the SAME harness against a deliberately unguarded read-then-write decrement, and
   * it MUST oversell. If this test ever reports "no oversell", the harness is not actually
   * concurrent — the barrier is broken, or the connections are secretly shared — and the test
   * above proves nothing at all while appearing green.
   *
   * A concurrency test without a negative control is a test that passes on a single-threaded
   * mock.
   */
  it("negative control: an unguarded decrement MUST oversell", async () => {
    const connections = await Promise.all(
      Array.from({ length: CONTENDERS }, () => distinctConnection()),
    );

    let oversoldAtLeastOnce = false;
    let worstRemaining = 0;

    for (let round = 0; round < 10 && !oversoldAtLeastOnce; round++) {
      await truncateAll();
      cat = await seedCatalogue(db);
      await injectCapital(db, 1_000_000);
      const batchId = await receiveBatch(1, 100);

      const barrier = makeBarrier(CONTENDERS);

      const attempts = connections.map((conn) =>
        (async () => {
          await barrier.wait();
          try {
            await conn.transaction(async (tx) => {
              // ---- THE BUG, ON PURPOSE ----
              // Read, decide, then write. Two readers both see 1 and both sell it.
              const [row] = await tx
                .select({ qtyRemaining: batches.qtyRemaining })
                .from(batches)
                .where(eq(batches.id, batchId))
                .limit(1);

              if (!row || row.qtyRemaining < 1) throw new Error("sold out");

              // Small delay to widen the window the guarded version closes entirely.
              await tx.execute(sql`SELECT pg_sleep(0.02)`);

              await tx
                .update(batches)
                .set({ qtyRemaining: row.qtyRemaining - 1 })
                .where(eq(batches.id, batchId)); // <-- no qty_remaining >= 1 guard
            });
            return true;
          } catch {
            return false;
          }
        })(),
      );

      await barrier.ready;
      barrier.release();
      const results = await Promise.all(attempts);
      const winners = results.filter(Boolean).length;

      const [row] = await db.select().from(batches).where(eq(batches.id, batchId));
      worstRemaining = Math.min(worstRemaining, row.qtyRemaining);

      // Oversold either by more than one "successful" sale of a single unit, or by the stock
      // going below zero outright.
      if (winners > 1 || row.qtyRemaining < 0) oversoldAtLeastOnce = true;
    }

    expect(
      oversoldAtLeastOnce,
      "NEGATIVE CONTROL FAILED: the unguarded decrement did not oversell, which means this " +
        "harness is not genuinely concurrent and the oversell test above proves nothing.",
    ).toBe(true);
  }, 300_000);
});
