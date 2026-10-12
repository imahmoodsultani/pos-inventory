import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { capitalEvents, cashEvents } from "@/lib/db/schema";
import { getEditHistory } from "@/lib/services/audit";
import {
  correctCapitalEvent,
  getCashOnHandMinor,
  recordCapitalInjection,
  recordWithdrawal,
} from "@/lib/services/capital";
import { receiveStock } from "@/lib/services/receiving";

import { ACTOR, seedCatalogue } from "./fixtures";
import { assertInvariants, expectIdentity } from "./invariants";
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

const now = () => new Date();

async function inject(amountMinor: number) {
  return db.transaction((tx) =>
    recordCapitalInjection(tx as Tx, ACTOR, { amountMinor, occurredAt: now() }),
  );
}

describe("capital correction (FR-046, FR-046a)", () => {
  it("corrects a mistyped injection and moves cash and capital by exactly the difference", async () => {
    // The motivating case: 50,000 typed where 5,000 was meant.
    const event = await inject(50_000);
    await expectIdentity(db, { capitalInvestedMinor: 50_000, cashOnHandMinor: 50_000 });

    const result = await db.transaction((tx) =>
      correctCapitalEvent(tx as Tx, ACTOR, {
        eventId: event.eventId,
        amountMinor: 5_000,
        occurredAt: now(),
        reason: "Typed 50,000 instead of 5,000",
      }),
    );

    expect(result.capitalInvestedMinor).toBe(5_000);
    expect(result.cashOnHandMinor).toBe(5_000);

    // Both rows moved together — the whole point.
    const [capital] = await db.select().from(capitalEvents);
    const [cash] = await db.select().from(cashEvents);
    expect(capital.amountMinor).toBe(5_000);
    expect(cash.amountMinor).toBe(5_000);

    await expectIdentity(db, { capitalInvestedMinor: 5_000, cashOnHandMinor: 5_000 });
    await assertInvariants(db);
  });

  it("records the correction with its reason, previous and new value", async () => {
    const event = await inject(50_000);
    await db.transaction((tx) =>
      correctCapitalEvent(tx as Tx, ACTOR, {
        eventId: event.eventId,
        amountMinor: 5_000,
        occurredAt: now(),
        reason: "Extra zero",
      }),
    );

    const history = await getEditHistory(db, "capital_events", event.eventId);
    const amount = history.find((h) => h.fieldName === "amountMinor")!;
    expect(amount.oldValue).toBe("50000");
    expect(amount.newValue).toBe("5000");
    expect(amount.reason).toBe("Extra zero");
    expect(amount.changedBy).toBe(ACTOR);
  });

  it("refuses a correction with no reason", async () => {
    const event = await inject(1_000);
    for (const reason of ["", "   "]) {
      await expect(
        db.transaction((tx) =>
          correctCapitalEvent(tx as Tx, ACTOR, {
            eventId: event.eventId,
            amountMinor: 500,
            occurredAt: now(),
            reason,
          }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    // Nothing moved.
    expect((await db.select().from(capitalEvents))[0].amountMinor).toBe(1_000);
  });

  it("cannot flip an injection into a withdrawal (FR-046a)", async () => {
    const event = await inject(1_000);
    // eventType is absent from the input type entirely — unrepresentable, not merely rejected.
    await db.transaction((tx) =>
      correctCapitalEvent(tx as Tx, ACTOR, {
        eventId: event.eventId,
        amountMinor: 900,
        occurredAt: now(),
        reason: "Adjust",
        ...({ eventType: "withdrawal" } as object),
      }),
    );
    const [row] = await db.select().from(capitalEvents);
    expect(row.eventType).toBe("injection");
  });

  it("refuses a withdrawal correction that would overdraw the till", async () => {
    await inject(1_000);
    const withdrawal = await db.transaction((tx) =>
      recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 400, occurredAt: now() }),
    );
    // Cash is 600. Raising the withdrawal to 1,500 would leave -500.
    const error = (await db
      .transaction((tx) =>
        correctCapitalEvent(tx as Tx, ACTOR, {
          eventId: withdrawal.eventId,
          amountMinor: 1_500,
          occurredAt: now(),
          reason: "Too much",
        }),
      )
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(error.code).toBe("INSUFFICIENT_CASH");
    expect(error.message).toMatch(/\b600\b/);
    expect(await db.transaction((tx) => getCashOnHandMinor(tx as Tx))).toBe(600);
  });

  /**
   * The non-obvious direction, and the reason 6.2 exists as its own task.
   *
   * Reducing a past INJECTION takes money out of the till just as surely as raising a withdrawal,
   * because the money that arrived may already have been spent on stock.
   */
  it("refuses an injection correction downward below money already spent", async () => {
    const event = await inject(10_000);
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 9_000,
        landedCostMinor: 0,
        receivedAt: now(),
        funding: { newCapitalMinor: 9_000, reinvestedMinor: 0 },
      }),
    );
    // Cash is 1,000; 9,000 is now stock. Reducing the injection to 500 would leave -8,500.
    const error = (await db
      .transaction((tx) =>
        correctCapitalEvent(tx as Tx, ACTOR, {
          eventId: event.eventId,
          amountMinor: 500,
          occurredAt: now(),
          reason: "Was actually much smaller",
        }),
      )
      .catch((e: unknown) => e)) as { code: string };

    expect(error.code).toBe("INSUFFICIENT_CASH");
    await assertInvariants(db);
  });

  it("allows a reduction down to exactly the money still available", async () => {
    const event = await inject(10_000);
    await db.transaction((tx) =>
      receiveStock(tx as Tx, ACTOR, {
        productId: cat.product,
        vendorId: cat.vendorA,
        gradeId: cat.gradeA,
        qtyReceived: 10,
        goodsCostMinor: 9_000,
        landedCostMinor: 0,
        receivedAt: now(),
        funding: { newCapitalMinor: 9_000, reinvestedMinor: 0 },
      }),
    );
    // Cash 1,000 — so the injection can come down to 9,000, leaving exactly zero.
    await db.transaction((tx) =>
      correctCapitalEvent(tx as Tx, ACTOR, {
        eventId: event.eventId,
        amountMinor: 9_000,
        occurredAt: now(),
        reason: "Boundary",
      }),
    );
    expect(await db.transaction((tx) => getCashOnHandMinor(tx as Tx))).toBe(0);
    await assertInvariants(db);
  });

  it("rejects a non-positive amount", async () => {
    const event = await inject(1_000);
    for (const amountMinor of [0, -5]) {
      await expect(
        db.transaction((tx) =>
          correctCapitalEvent(tx as Tx, ACTOR, {
            eventId: event.eventId,
            amountMinor,
            occurredAt: now(),
            reason: "Zero it",
          }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("keeps the identity exact across arbitrary corrections", async () => {
    // The property that matters. Any correction, any amount, identity still balances.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 500_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        async (initial, corrected) => {
          await truncateAll();
          cat = await seedCatalogue(db);
          const event = await inject(initial);

          await db
            .transaction((tx) =>
              correctCapitalEvent(tx as Tx, ACTOR, {
                eventId: event.eventId,
                amountMinor: corrected,
                occurredAt: now(),
                reason: "property test",
              }),
            )
            .catch(() => undefined); // a refused correction is a valid outcome

          await assertInvariants(db);
        },
      ),
      { numRuns: 25 },
    );
  }, 180_000);

  it("a correction that changes nothing writes no audit record", async () => {
    const event = await inject(1_000);
    const [before] = await db.select().from(capitalEvents);
    await db.transaction((tx) =>
      correctCapitalEvent(tx as Tx, ACTOR, {
        eventId: event.eventId,
        amountMinor: 1_000,
        occurredAt: before.occurredAt,
        note: before.note,
        reason: "No change",
      }),
    );
    expect(await getEditHistory(db, "capital_events", event.eventId)).toHaveLength(0);
  });

  it("a failed correction rolls back both rows together", async () => {
    await inject(1_000);
    const withdrawal = await db.transaction((tx) =>
      recordWithdrawal(tx as Tx, ACTOR, { amountMinor: 400, occurredAt: now() }),
    );

    await expect(
      db.transaction((tx) =>
        correctCapitalEvent(tx as Tx, ACTOR, {
          eventId: withdrawal.eventId,
          amountMinor: 99_999,
          occurredAt: now(),
          reason: "Overdraw",
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" });

    // Neither row moved, and no audit record claims they did.
    const [capital] = await db
      .select()
      .from(capitalEvents)
      .where(eq(capitalEvents.id, withdrawal.eventId));
    expect(capital.amountMinor).toBe(400);
    expect(await getEditHistory(db, "capital_events", withdrawal.eventId)).toHaveLength(0);
    await assertInvariants(db);
  });
});
