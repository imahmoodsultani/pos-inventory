import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Tx } from "@/lib/db";
import { capitalEvents } from "@/lib/db/schema";
import {
  getCashOnHandMinor,
  recordCapitalInjection,
  recordWithdrawal,
} from "@/lib/services/capital";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";

import { ACTOR, seedCatalogue } from "./fixtures";
import { assertInvariants, expectIdentity } from "./invariants";
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
});

const now = () => new Date();

describe("US3 — capital and cash (FR-024, FR-025, FR-031)", () => {
  it("an injection raises cash and capital invested by the same amount", async () => {
    const result = await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 50_000, occurredAt: now() }),
    );

    expect(result.cashOnHandMinor).toBe(50_000);
    expect(result.capitalInvestedMinor).toBe(50_000);
    expect(result.capitalRecoveredMinor).toBe(0);
    await expectIdentity(db, {
      capitalInvestedMinor: 50_000,
      cashOnHandMinor: 50_000,
      inventoryAtCostMinor: 0,
      profitToDateMinor: 0,
    });
  });

  it("a withdrawal lowers cash and raises capital RECOVERED, not lowering invested", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 50_000, occurredAt: now() }),
    );

    const result = await db.transaction((tx) =>
      recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 20_000, occurredAt: now() }),
    );

    // "I put in 50,000 and have taken 20,000 back" — netting these to "invested 30,000" would
    // destroy exactly the story the owner asked for.
    expect(result.capitalInvestedMinor).toBe(50_000);
    expect(result.capitalRecoveredMinor).toBe(20_000);
    expect(result.cashOnHandMinor).toBe(30_000);
    await assertInvariants(db);
  });

  it("refuses a withdrawal larger than cash on hand, naming the balance (FR-031)", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 1_000, occurredAt: now() }),
    );

    const error = (await db
      .transaction((tx) =>
        recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 1_001, occurredAt: now() }),
      )
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(error.code).toBe("INSUFFICIENT_CASH");
    expect(error.message).toContain("1000");

    // Nothing recorded, balance untouched.
    expect(await db.select().from(capitalEvents)).toHaveLength(1);
    expect(await db.transaction((tx) => getCashOnHandMinor(tx as Tx))).toBe(1_000);
    await assertInvariants(db);
  });

  it("rejects zero and negative amounts", async () => {
    for (const amountMinor of [0, -100]) {
      await expect(
        db.transaction((tx) =>
          recordCapitalInjection(tx as Tx, ACTOR, { amountMinor, occurredAt: now() }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  /**
   * FR-026a, the finding that broke the identity in the original design.
   *
   * A purchase moves value from cash into inventory. It must NOT raise capital invested, however
   * it was funded — "bought with new capital" describes which pocket the already-counted money
   * came from, not a second injection.
   */
  it("a mixed-funding purchase leaves capital invested UNCHANGED", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 10_000, occurredAt: now() }),
    );

    // Sell something first so there are retained proceeds to reinvest.
    const first = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1_000,
        landedCostMinor: 0,
        receivedAt: now(),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
      }),
    );
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: first.batchId, quantity: 10, unitPriceMinor: 200 }],
      }),
    );

    const beforeCash = await db.transaction((tx) => getCashOnHandMinor(tx as Tx));

    // Half new capital, half reinvested revenue.
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorB,
        gradeId: cat.gradeB,
        qtyReceived: 10,
        goodsCostMinor: 2_000,
        landedCostMinor: 0,
        receivedAt: now(),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 1_000 },
      }),
    );

    const afterCash = await db.transaction((tx) => getCashOnHandMinor(tx as Tx));

    // Cash falls by the FULL cost regardless of the split...
    expect(beforeCash - afterCash).toBe(2_000);

    // ...and capital invested is still just the one injection.
    await expectIdentity(db, { capitalInvestedMinor: 10_000, capitalRecoveredMinor: 0 });
    await assertInvariants(db);
  });

  it("caps reinvestment at retained proceeds, and a second purchase cannot reuse them", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 10_000, occurredAt: now() }),
    );
    const batch = await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 1_000,
        landedCostMinor: 0,
        receivedAt: now(),
        funding: { newCapitalMinor: 1_000, reinvestedMinor: 0 },
      }),
    );
    // Proceeds of exactly 1,500.
    await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId: batch.batchId, quantity: 10, unitPriceMinor: 150 }],
      }),
    );

    const reinvest = (amount: number) =>
      db.transaction((tx) =>
        receiveStock(tx as Tx, ACTOR, {
          productId: cat.product,
          vendorId: cat.vendorA,
          gradeId: cat.gradeA,
          qtyReceived: 5,
          goodsCostMinor: amount,
          landedCostMinor: 0,
          receivedAt: now(),
          funding: { newCapitalMinor: 0, reinvestedMinor: amount },
        }),
      );

    // More than was earned → refused.
    await expect(reinvest(1_501)).rejects.toMatchObject({ code: "VALIDATION" });

    // Exactly the proceeds → allowed.
    await reinvest(1_500);

    // The SAME proceeds cannot be reinvested twice — prior reinvestment is subtracted.
    await expect(reinvest(1)).rejects.toMatchObject({ code: "VALIDATION" });

    await assertInvariants(db);
  });

  /**
   * The cash floor is a read-then-write check, which is the exact shape the guarded conditional
   * UPDATE exists to avoid on stock. assertCashAvailable claims safety via a transaction-scoped
   * advisory lock — so that claim gets tested rather than trusted.
   */
  it("two concurrent withdrawals cannot both pass the cash floor", async () => {
    await db.transaction((tx) =>
      recordCapitalInjection(tx as Tx, ACTOR, { amountMinor: 1_000, occurredAt: now() }),
    );

    const a = await distinctConnection();
    const b = await distinctConnection();

    // Each wants 600 of a 1,000 balance. Exactly one may succeed.
    const attempts = [a, b].map((conn) =>
      conn
        .transaction((tx) =>
          recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 600, occurredAt: now() }),
        )
        .then(() => true)
        .catch(() => false),
    );

    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(1);

    const balance = await db.transaction((tx) => getCashOnHandMinor(tx as Tx));
    expect(balance, "cash went negative — the floor was bypassed").toBe(400);
    expect(balance).toBeGreaterThanOrEqual(0);
    await assertInvariants(db);
  }, 60_000);
});
