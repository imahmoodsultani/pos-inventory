import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Tx } from "@/lib/db";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale, redactForRole } from "@/lib/services/sale";
import { recordSaleReturn } from "@/lib/services/sale-reversal";

import { ACTOR, injectCapital, seedCatalogue } from "./fixtures";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

let db: TestDb;
let cat: Awaited<ReturnType<typeof seedCatalogue>>;
let batchId: number;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});
beforeEach(async () => {
  await truncateAll();
  cat = await seedCatalogue(db);
  await injectCapital(db, 1_000_000);
  const r = await db.transaction((tx) =>
    receiveStock(tx as Tx, ACTOR, {
      productId: cat.product,
      vendorId: cat.vendorA,
      gradeId: cat.gradeA,
      qtyReceived: 10,
      goodsCostMinor: 1000,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: 1000, reinvestedMinor: 0 },
    }),
  );
  batchId = r.batchId;
});

/** Any key that would leak margin, capital position, or cash to a salesperson. */
const FORBIDDEN = [
  "cost",
  "profit",
  "capital",
  "cash",
  "margin",
  "goodsCost",
  "landedCost",
  "totalCost",
  "reinvested",
  "newCapital",
];

function assertNoForbiddenKeys(value: unknown, path = "result"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenKeys(item, `${path}[${i}]`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    const offending = FORBIDDEN.find((f) => lowered.includes(f.toLowerCase()));
    expect(
      offending,
      `${path}.${key} would expose "${offending}" to a salesperson`,
    ).toBeUndefined();
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

/**
 * SC-010 asserted on the SHAPE OF THE RETURNED OBJECT, not on rendered UI.
 *
 * Hiding a column in a table hides nothing: the value still travels to the browser inside the
 * RSC payload, where it sits in the page source for anyone who looks. The only real boundary is
 * never putting the value in the response at all.
 */
describe("US2 — a salesperson never receives a cost figure (SC-010, FR-041b)", () => {
  it("recordSale's result carries no cost or profit for a salesperson", async () => {
    const full = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 2, unitPriceMinor: 150 }],
      }),
    );

    // The owner's view has the figures...
    expect(full.costMinor).toBe(200);
    expect(full.profitMinor).toBe(100);

    // ...the salesperson's does not have the KEYS AT ALL.
    const redacted = redactForRole(full, "salesperson");
    expect("costMinor" in redacted).toBe(false);
    expect("profitMinor" in redacted).toBe(false);
    assertNoForbiddenKeys(redacted);

    // They still get everything needed to finish serving the customer.
    expect(redacted.saleNumber).toBe(full.saleNumber);
    expect(redacted.revenueMinor).toBe(300);
  });

  it("the owner's result is left untouched", async () => {
    const full = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 2, unitPriceMinor: 150 }],
      }),
    );
    expect(redactForRole(full, "owner")).toEqual(full);
  });

  it("a return gives a salesperson the refund but not the reversed margin", async () => {
    const sale = await db.transaction((tx) =>
      recordSale(tx as Tx, ACTOR, {
        paymentMethod: "cash",
        lines: [{ batchId, quantity: 4, unitPriceMinor: 150 }],
      }),
    );

    const result = await db.transaction((tx) =>
      recordSaleReturn(tx as Tx, ACTOR, "salesperson", {
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lines[0].saleLineId, quantity: 1 }],
        reason: "Changed their mind",
        idempotencyId: 1,
      }),
    );

    // refundMinor is deliberately allowed — they must hand that money over.
    expect(result.refundMinor).toBe(150);
    expect("reversedCostMinor" in result).toBe(false);
    expect("reversedProfitMinor" in result).toBe(false);
  });

  it("the till's availability query selects no cost columns", async () => {
    /**
     * getStockAvailability is the only stock read a salesperson can reach, and the guarantee is
     * "never selected", not "stripped afterwards".
     *
     * Read from the source file rather than imported: importing lib/dal/queries pulls in the
     * live pool, and inspecting the real source is a stronger assertion than inspecting a
     * transpiled function body anyway.
     */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/dal/queries.ts", "utf8");

    const start = source.indexOf("export async function getStockAvailability");
    expect(start, "getStockAvailability not found").toBeGreaterThan(-1);
    const end = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    for (const forbidden of ["totalCostMinor", "goodsCostMinor", "landedCostMinor"]) {
      expect(body, `getStockAvailability references ${forbidden}`).not.toContain(forbidden);
    }
    // And confirm we actually captured the function, not an empty slice.
    expect(body).toContain("qtyRemaining");
  });

  it("the guard itself works — it would catch a leak", async () => {
    // A test that can never fail proves nothing, so prove the detector detects.
    expect(() =>
      assertNoForbiddenKeys({ saleId: 1, costMinor: 200 }),
    ).toThrow();
    expect(() =>
      assertNoForbiddenKeys({ lines: [{ ok: 1 }, { unitCostMinorAtSale: 100 }] }),
    ).toThrow();
  });
});
