import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { batches, fundingAllocations } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { addLandedCost, receiveStock } from "@/lib/services/receiving";
import { displayUnitCost } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { assertInvariants } from "./invariants";
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
  await injectCapital(db, 100_000);
});

async function receive(qty: number, goodsCostMinor: number) {
  return db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qtyReceived: qty,
      goodsCostMinor,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: goodsCostMinor, reinvestedMinor: 0 },
    }),
  );
}

async function fundingFor(batchId: number) {
  const rows = await db.execute<{ funded: number; total: number }>(sql`
    SELECT f.new_capital_minor + f.reinvested_minor AS funded, b.total_cost_minor AS total
      FROM funding_allocations f
      JOIN batches b ON b.id = f.batch_id
     WHERE f.batch_id = ${batchId}
  `);
  const row = (Array.isArray(rows) ? rows : rows.rows)[0];
  return { funded: Number(row.funded), total: Number(row.total) };
}

/**
 * plan.md names this as a silent-breakage risk: adding a landed cost changes
 * `batches.total_cost_minor`, and if `funding_allocations` is not re-balanced in the SAME
 * transaction, the FR-026 invariant breaks with no error anywhere until the nightly reconcile.
 */
describe("US1 — landed cost added after receipt (FR-007, FR-026)", () => {
  it("raises the effective per-unit cost proportionally", async () => {
    const batch = await receive(10, 1000);

    const before = displayUnitCost(minor(1000) as Minor, 10);
    expect(before.unitCostFloorMinor).toBe(100);

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 1,
        reason: "Freight",
      }),
    );

    const [row] = await db.select().from(batches).where(eq(batches.id, batch.batchId));
    expect(row.totalCostMinor).toBe(1200);
    // total_cost_minor is GENERATED — it followed the landed cost without being written.
    expect(row.goodsCostMinor).toBe(1000);
    expect(row.landedCostMinor).toBe(200);

    const after = displayUnitCost(minor(row.totalCostMinor) as Minor, row.qtyReceived);
    expect(after.unitCostFloorMinor).toBe(120);
  });

  it("re-balances the funding allocation in the SAME transaction", async () => {
    const batch = await receive(10, 1000);
    expect(await fundingFor(batch.batchId)).toEqual({ funded: 1000, total: 1000 });

    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 2,
        reason: "Freight",
      }),
    );

    // The assertion plan.md asked for. If the re-balance were missing, funded would still be
    // 1000 against a total of 1200 and nothing would have complained.
    const { funded, total } = await fundingFor(batch.batchId);
    expect(funded).toBe(total);
    expect(total).toBe(1200);

    const [funding] = await db
      .select()
      .from(fundingAllocations)
      .where(eq(fundingAllocations.batchId, batch.batchId));
    // Default attribution: the extra came out of pocket.
    expect(funding.newCapitalMinor).toBe(1200);
    expect(funding.reinvestedMinor).toBe(0);
  });

  it("writes no adjustment when nothing has been sold yet", async () => {
    const batch = await receive(10, 1000);

    const result = await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 3,
        reason: "Freight",
      }),
    );

    // Nothing sold means nothing was mis-attributed, so there is no difference to book.
    // The whole 200 simply raises the value of the units still on the shelf.
    expect(result.adjustmentMinor).toBe(0);
    expect(result.adjustmentMovementId).toBeNull();
    await assertInvariants(db);
  });

  it("pays for the extra cost, refusing if cash will not cover it", async () => {
    const batch = await receive(10, 1000);

    await expect(
      db.transaction((tx) =>
        addLandedCost(tx as Tx, ACTOR, {
          batchId: batch.batchId,
          additionalCostMinor: 10_000_000,
          idempotencyId: 4,
          reason: "Absurd freight",
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" });

    // Rolled back whole: the cost change must not survive a failed payment.
    const [row] = await db.select().from(batches).where(eq(batches.id, batch.batchId));
    expect(row.totalCostMinor).toBe(1000);
    await assertInvariants(db);
  });

  it("keeps the identity balanced", async () => {
    const batch = await receive(10, 1000);
    await db.transaction((tx) =>
      addLandedCost(tx as Tx, ACTOR, {
        batchId: batch.batchId,
        additionalCostMinor: 200,
        idempotencyId: 5,
        reason: "Freight",
      }),
    );
    await assertInvariants(db);
  });
});
