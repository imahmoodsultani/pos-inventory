import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { recordEdits, sessions, users } from "@/lib/db/schema";
import { getEditHistory } from "@/lib/services/audit";
import {
  createStaffUser,
  listStaff,
  resetUserPassword,
  setUserActive,
  setUserRole,
  updateStaffDetails,
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

describe("staff account editing (FR-047)", () => {
  async function makeSalesperson(email = "sales@example.test") {
    return db.transaction((tx) =>
      createStaffUser(tx as Tx, "seed", {
        email,
        name: "Sales",
        password: "a-long-enough-password",
        role: "salesperson",
      }),
    );
  }

  async function giveSession(userId: string, id: string) {
    await db.insert(sessions).values({
      id,
      userId,
      token: `token-${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  it("corrects a name without touching sessions", async () => {
    const { userId } = await makeSalesperson();
    await giveSession(userId, "s-name");

    const result = await db.transaction((tx) =>
      updateStaffDetails(tx as Tx, "owner-1", { userId, name: "Sales Person" }),
    );

    expect(result.signedOut).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.name).toBe("Sales Person");
    // A typo in a name is not a security event. Signing them out for it would be gratuitous.
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
  });

  /**
   * The email IS the sign-in identifier. Changing it means whoever holds the old address can no
   * longer get in and whoever holds the new one now can — so the live sessions must not survive it.
   */
  it("ends every session when the email changes", async () => {
    const { userId } = await makeSalesperson();
    await giveSession(userId, "s-a");
    await giveSession(userId, "s-b");

    const result = await db.transaction((tx) =>
      updateStaffDetails(tx as Tx, "owner-1", { userId, email: "new-sales@example.test" }),
    );

    expect(result.signedOut).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.email).toBe("new-sales@example.test");
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
  });

  it("does not sign anyone else out", async () => {
    const owner = await makeOwner();
    const sales = await makeSalesperson();
    await giveSession(owner.userId, "s-owner");
    await giveSession(sales.userId, "s-sales");

    await db.transaction((tx) =>
      updateStaffDetails(tx as Tx, owner.userId, {
        userId: sales.userId,
        email: "moved@example.test",
      }),
    );

    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toHaveLength(1);
  });

  it("refuses an email already used by another account, and changes nothing", async () => {
    const owner = await makeOwner();
    const sales = await makeSalesperson();
    await giveSession(sales.userId, "s-keep");

    const error = (await db
      .transaction((tx) =>
        updateStaffDetails(tx as Tx, owner.userId, {
          userId: sales.userId,
          email: ownerInput.email,
        }),
      )
      .catch((e: unknown) => e)) as { code: string; fieldErrors?: Record<string, string[]> };

    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors?.email).toBeTruthy();

    const [row] = await db.select().from(users).where(eq(users.id, sales.userId));
    expect(row.email).toBe("sales@example.test");
    // The refusal must not have ended their sessions on the way out.
    expect(await db.select().from(sessions).where(eq(sessions.userId, sales.userId))).toHaveLength(
      1,
    );
  });

  it("treats an account keeping its own email as a no-op, not a conflict", async () => {
    const { userId } = await makeSalesperson();
    await giveSession(userId, "s-noop");

    const result = await db.transaction((tx) =>
      updateStaffDetails(tx as Tx, "owner-1", {
        userId,
        name: "Sales",
        email: "sales@example.test",
      }),
    );

    expect(result.signedOut).toBe(false);
    expect(await getEditHistory(db, "users", userId)).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
  });

  it("audits who changed what, with both values", async () => {
    const { userId } = await makeSalesperson();
    await db.transaction((tx) =>
      updateStaffDetails(tx as Tx, "owner-1", {
        userId,
        name: "Renamed",
        email: "renamed@example.test",
      }),
    );

    const history = await getEditHistory(db, "users", userId);
    expect(history).toHaveLength(2);
    expect(new Set(history.map((h) => h.editGroup)).size).toBe(1);
    expect(history.every((h) => h.changedBy === "owner-1")).toBe(true);

    const email = history.find((h) => h.fieldName === "email")!;
    expect(email.oldValue).toBe("sales@example.test");
    expect(email.newValue).toBe("renamed@example.test");
  });

  it("a password reset ends sessions and stores NO password value anywhere in the audit", async () => {
    const { userId } = await makeSalesperson();
    await giveSession(userId, "s-pw");
    const secret = "a-brand-new-password";

    await db.transaction((tx) => resetUserPassword(tx as Tx, "owner-1", { userId, password: secret }));

    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    // The reset is recorded — an owner needs to see it happened — but both value columns are
    // null, and the secret appears nowhere in the table at all.
    const history = await getEditHistory(db, "users", userId);
    const entry = history.find((h) => h.fieldName === "password")!;
    expect(entry).toBeTruthy();
    expect(entry.oldValue).toBeNull();
    expect(entry.newValue).toBeNull();

    const all = await db.select().from(recordEdits);
    expect(JSON.stringify(all)).not.toContain(secret);
  });

  it("the new password actually works and the old one does not", async () => {
    const { userId } = await makeSalesperson();
    const { auth } = await import("@/lib/auth/config");
    const ctx = await auth.$context;

    await db.transaction((tx) =>
      resetUserPassword(tx as Tx, "owner-1", { userId, password: "the-new-password" }),
    );

    const credential = await ctx.internalAdapter.findCredentialAccount(userId);

    // `updatePassword` stores its argument verbatim, so this guards against the password going in
    // as plain text — which would be both a leak and an account that cannot sign in.
    expect(credential!.password).not.toBe("the-new-password");

    expect(
      await ctx.password.verify({ hash: credential!.password!, password: "the-new-password" }),
    ).toBe(true);
    expect(
      await ctx.password.verify({
        hash: credential!.password!,
        password: "a-long-enough-password",
      }),
    ).toBe(false);
  });

  it("refuses to edit an account that does not exist", async () => {
    await expect(
      db.transaction((tx) =>
        updateStaffDetails(tx as Tx, "owner-1", { userId: "nobody", name: "Ghost" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
