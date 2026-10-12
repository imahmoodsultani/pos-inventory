import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import {
  createStaffUser,
  listStaff,
  setUserActive,
  setUserRole,
} from "@/lib/services/users";

import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

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

const ownerInput = {
  email: "owner@example.test",
  name: "Owner",
  password: "a-long-enough-password",
  role: "owner" as const,
};

async function makeOwner() {
  return db.transaction((tx) => createStaffUser(tx as Tx, "seed", ownerInput));
}

describe("staff accounts (FR-041, FR-041a)", () => {
  it("creates an account that can actually sign in", async () => {
    const { userId } = await makeOwner();

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.role).toBe("owner");
    expect(row.isActive).toBe(true);

    // The credential account is the part that silently goes missing: createUser does not make
    // one, and without it the account exists but can never authenticate.
    const { auth } = await import("@/lib/auth/config");
    const ctx = await auth.$context;
    const credential = await ctx.internalAdapter.findCredentialAccount(userId);
    expect(credential?.password).toBeTruthy();
  });

  it("refuses a duplicate email", async () => {
    await makeOwner();
    await expect(
      db.transaction((tx) => createStaffUser(tx as Tx, "seed", ownerInput)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  /**
   * THE LOCKOUT GUARD.
   *
   * There is no public sign-up and no password-reset email. Deactivating the last active owner
   * would lock everyone out of their own books with no way back in short of editing the database
   * by hand — a single mis-click costing the business its system.
   */
  it("refuses to deactivate the LAST active owner", async () => {
    const { userId } = await makeOwner();

    const error = (await db
      .transaction((tx) => setUserActive(tx as Tx, "seed", { userId, isActive: false }))
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(error.code).toBe("CONFLICT");
    // The message must say the way out, not just "no".
    expect(error.message).toMatch(/only active owner/i);
    expect(error.message).toMatch(/someone else an owner first/i);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.isActive).toBe(true);
  });

  it("refuses to demote the LAST owner", async () => {
    const { userId } = await makeOwner();
    await expect(
      db.transaction((tx) =>
        setUserRole(tx as Tx, "seed", { userId, role: "salesperson" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows deactivating an owner once another active owner exists", async () => {
    const first = await makeOwner();
    await db.transaction((tx) =>
      createStaffUser(tx as Tx, "seed", {
        ...ownerInput,
        email: "second-owner@example.test",
        name: "Second Owner",
      }),
    );

    await db.transaction((tx) =>
      setUserActive(tx as Tx, "seed", { userId: first.userId, isActive: false }),
    );

    const [row] = await db.select().from(users).where(eq(users.id, first.userId));
    expect(row.isActive).toBe(false);
  });

  it("deactivating a salesperson is always allowed and ends their sessions immediately", async () => {
    await makeOwner();
    const sales = await db.transaction((tx) =>
      createStaffUser(tx as Tx, "seed", {
        email: "sales@example.test",
        name: "Sales",
        password: "a-long-enough-password",
        role: "salesperson",
      }),
    );

    await db.insert(sessions).values({
      id: "session-1",
      userId: sales.userId,
      token: "token-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await db.transaction((tx) =>
      setUserActive(tx as Tx, "seed", { userId: sales.userId, isActive: false }),
    );

    // FR-041a — deactivation takes effect now, not whenever their session happens to expire.
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, sales.userId));
    expect(remaining).toHaveLength(0);
  });

  it("lists everyone, active or not — accounts are never deleted", async () => {
    await makeOwner();
    await db.transaction((tx) =>
      createStaffUser(tx as Tx, "seed", {
        email: "sales@example.test",
        name: "Sales",
        password: "a-long-enough-password",
        role: "salesperson",
      }),
    );
    const staff = await db.transaction((tx) => listStaff(tx as Tx));
    expect(staff).toHaveLength(2);
  });
});
