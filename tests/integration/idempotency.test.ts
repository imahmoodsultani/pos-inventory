import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from "@/lib/services/idempotency";
import { idempotencyKeys } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import {
  distinctConnection,
  startTestDatabase,
  stopTestDatabase,
  truncateAll,
  type TestDb,
} from "./setup";
import { assertInvariants } from "./invariants";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
});

const SCOPE = "user-1";
const KEY = "11111111-2222-3333-4444-555555555555";

const payload = { lines: [{ batchId: 1, quantity: 2 }], paymentMethod: "cash" };

describe("hashRequest", () => {
  it("is stable across key order, so a reordered retry is not mistaken for a new request", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1, b: { c: 3, d: 4 } })).toBe(
      hashRequest({ b: { d: 4, c: 3 }, a: 1 }),
    );
  });

  it("changes when the data changes", () => {
    expect(hashRequest({ qty: 2 })).not.toBe(hashRequest({ qty: 3 }));
  });
});

describe("claimIdempotencyKey", () => {
  it("claims once, then replays the stored response for the same payload", async () => {
    const hash = hashRequest(payload);

    const first = await db.transaction(async (tx) => {
      const outcome = await claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      });
      expect(outcome.status).toBe("claimed");
      if (outcome.status !== "claimed") throw new Error("unreachable");
      await completeIdempotencyKey(tx as Tx, outcome.id, { saleId: 42, saleNumber: "S-0001" });
      return outcome;
    });
    expect(first.status).toBe("claimed");

    const second = await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      }),
    );

    expect(second.status).toBe("replay");
    if (second.status !== "replay") throw new Error("unreachable");
    expect(second.responseBody).toEqual({ saleId: 42, saleNumber: "S-0001" });

    // The whole point: the duplicate wrote nothing a second time.
    const rows = await db.select().from(idempotencyKeys);
    expect(rows).toHaveLength(1);
  });

  it("returns conflict when the same key carries a different payload", async () => {
    await db.transaction(async (tx) => {
      const outcome = await claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hashRequest(payload),
      });
      if (outcome.status !== "claimed") throw new Error("expected claim");
      await completeIdempotencyKey(tx as Tx, outcome.id, { saleId: 1 });
    });

    const conflicting = await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        // Same key, but the cashier changed the basket — must never replay the old receipt.
        requestHash: hashRequest({ ...payload, lines: [{ batchId: 1, quantity: 99 }] }),
      }),
    );

    expect(conflicting.status).toBe("conflict");
  });

  it("reports in_flight while the first attempt is still running", async () => {
    const hash = hashRequest(payload);

    // Claim on one connection and HOLD the transaction open.
    const holder = await distinctConnection();
    const other = await distinctConnection();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = holder.transaction(async (tx) => {
      const outcome = await claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      });
      expect(outcome.status).toBe("claimed");
      await held; // keep the row uncommitted-but-locked for the duration
    });

    // Give the holder a moment to get its INSERT in.
    await new Promise((r) => setTimeout(r, 300));

    // A second caller's ON CONFLICT DO NOTHING blocks on the uncommitted row, so we race it
    // against a timeout: blocking IS the correct behaviour here — it is what prevents two
    // concurrent sales. What must NOT happen is a second successful claim.
    const secondClaim = other
      .transaction((tx) =>
        claimIdempotencyKey(tx as Tx, {
          scope: SCOPE,
          key: KEY,
          actionName: "recordSale",
          requestHash: hash,
        }),
      )
      .then((o) => o.status);

    const raced = await Promise.race([
      secondClaim,
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 1_000)),
    ]);

    expect(raced === "blocked" || raced === "in_flight").toBe(true);
    expect(raced).not.toBe("claimed");

    release();
    await holding;
    // Once the holder commits, the waiter resolves as a duplicate — never a second claim.
    expect(await secondClaim).not.toBe("claimed");
  });

  it("scopes keys per user, so two tills may reuse the same key value", async () => {
    const hash = hashRequest(payload);
    const a = await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: "user-1",
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      }),
    );
    const b = await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: "user-2",
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      }),
    );
    expect(a.status).toBe("claimed");
    expect(b.status).toBe("claimed");
  });

  it("rolls the claim back with the business write, so a failed sale can be retried", async () => {
    // This is why the claim lives INSIDE the business transaction. If it committed separately,
    // a crash after claiming would burn the key and the sale would be lost forever.
    const hash = hashRequest(payload);

    await expect(
      db.transaction(async (tx) => {
        const outcome = await claimIdempotencyKey(tx as Tx, {
          scope: SCOPE,
          key: KEY,
          actionName: "recordSale",
          requestHash: hash,
        });
        expect(outcome.status).toBe("claimed");
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");

    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);

    const retry = await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hash,
      }),
    );
    expect(retry.status).toBe("claimed");
  });

  it("sets a 72 hour expiry for the reaper", async () => {
    await db.transaction((tx) =>
      claimIdempotencyKey(tx as Tx, {
        scope: SCOPE,
        key: KEY,
        actionName: "recordSale",
        requestHash: hashRequest(payload),
      }),
    );
    const [row] = await db.execute<{ hours: number }>(
      sql`SELECT EXTRACT(EPOCH FROM (expires_at - now()))/3600 AS hours FROM idempotency_keys`,
    ).then((r) => (Array.isArray(r) ? r : r.rows));
    expect(Number(row.hours)).toBeGreaterThan(71);
    expect(Number(row.hours)).toBeLessThanOrEqual(72);
  });

  it("leaves all invariants holding", async () => {
    await assertInvariants(db);
  });
});
