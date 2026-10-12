import "server-only";

/**
 * Staff account management (T099, FR-041, FR-041a).
 *
 * Accounts are created HERE, by an owner — there is no public sign-up (lib/auth/config.ts sets
 * `disableSignUp`, which also disables the server-side signUpEmail API). Creation goes through
 * Better Auth's internal adapter so passwords are hashed by the same code that verifies them.
 *
 * Two rules this module exists to enforce:
 *   1. A role is assigned here, server-side, by an owner. It is never accepted from request
 *      input anywhere (`input: false` on the field).
 *   2. The LAST ACTIVE OWNER cannot be deactivated or demoted. Without that check a single
 *      mis-click locks everyone out of their own books permanently — there is no public sign-up
 *      and no other way back in.
 */

import { and, eq, ne } from "drizzle-orm";

import { auth } from "@/lib/auth/config";
import type { Tx } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { diffFields, recordEditsFor } from "@/lib/services/audit";
import { DomainError } from "@/lib/services/domain-error";

export type Role = "owner" | "salesperson";

async function countOtherActiveOwners(tx: Tx, excludingUserId: string): Promise<number> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.role, "owner"), eq(users.isActive, true), ne(users.id, excludingUserId)),
    );
  return rows.length;
}

export async function createStaffUser(
  tx: Tx,
  _actor: string,
  input: { email: string; name: string; password: string; role: Role },
): Promise<{ userId: string }> {
  const existing = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    throw new DomainError("CONFLICT", "An account with that email already exists.", {
      email: ["Already in use"],
    });
  }

  const ctx = await auth.$context;

  const created = await ctx.internalAdapter.createUser(
    {
      email: input.email.toLowerCase(),
      name: input.name,
      // Server-side only. `input: false` on the field means this can never arrive in a request.
      role: input.role,
      isActive: true,
    },
    { method: "admin" },
  );

  // createUser does NOT create a credential account, and updatePassword only updates an
  // existing one — so without this the account exists but can never sign in, silently.
  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await ctx.password.hash(input.password),
  });

  const credential = await ctx.internalAdapter.findCredentialAccount(created.id);
  if (!credential?.password) {
    throw new DomainError(
      "INTERNAL",
      "The account was created but has no usable password. Nothing was saved.",
    );
  }

  return { userId: created.id };
}

/**
 * Correct a staff member's name or email (FR-047).
 *
 * The email is the sign-in identifier, so changing it is not cosmetic: whoever holds the old
 * address can no longer sign in, and whoever holds the new one now can. Existing sessions are
 * therefore ended — the same reasoning as a password reset. An owner correcting their OWN typo
 * signs in again immediately with the corrected address, which is the point.
 */
export async function updateStaffDetails(
  tx: Tx,
  actor: string,
  input: { userId: string; name?: string; email?: string },
): Promise<{ userId: string; signedOut: boolean }> {
  const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!target) throw new DomainError("NOT_FOUND", "That account does not exist.");

  const email = input.email?.toLowerCase();

  if (email !== undefined && email !== target.email) {
    const clash = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, input.userId)))
      .limit(1);

    if (clash.length > 0) {
      throw new DomainError("CONFLICT", "Another account already uses that email address.", {
        email: ["Already in use"],
      });
    }
  }

  const changes = diffFields(
    { name: target.name, email: target.email },
    { name: input.name, email },
  );

  if (changes.length === 0) return { userId: input.userId, signedOut: false };

  await tx
    .update(users)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(email === undefined ? {} : { email }),
    })
    .where(eq(users.id, input.userId));

  await recordEditsFor(tx, actor, {
    tableName: "users",
    recordId: input.userId,
    changes,
  });

  const emailChanged = changes.some((c) => c.field === "email");
  if (emailChanged) {
    await tx.delete(sessions).where(eq(sessions.userId, input.userId));
  }

  return { userId: input.userId, signedOut: emailChanged };
}

export async function setUserActive(
  tx: Tx,
  _actor: string,
  input: { userId: string; isActive: boolean },
): Promise<{ userId: string }> {
  const [target] = await tx
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!target) throw new DomainError("NOT_FOUND", "That account does not exist.");

  if (!input.isActive && target.role === "owner") {
    const others = await countOtherActiveOwners(tx, input.userId);
    if (others === 0) {
      throw new DomainError(
        "CONFLICT",
        "This is the only active owner. Deactivating it would lock everyone out of the " +
          "business permanently — there is no public sign-up. Make someone else an owner first.",
      );
    }
  }

  await tx.update(users).set({ isActive: input.isActive }).where(eq(users.id, input.userId));

  // Deactivation must take effect NOW, not at session expiry (FR-041a). getSession() already
  // treats an inactive user as signed out; deleting their sessions closes the window entirely.
  if (!input.isActive) {
    await tx.delete(sessions).where(eq(sessions.userId, input.userId));
  }

  return { userId: input.userId };
}

export async function setUserRole(
  tx: Tx,
  _actor: string,
  input: { userId: string; role: Role },
): Promise<{ userId: string }> {
  const [target] = await tx
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!target) throw new DomainError("NOT_FOUND", "That account does not exist.");

  if (target.role === "owner" && input.role !== "owner") {
    const others = await countOtherActiveOwners(tx, input.userId);
    if (others === 0) {
      throw new DomainError(
        "CONFLICT",
        "This is the only owner. Promote someone else before changing this account's role.",
      );
    }
  }

  await tx.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
  return { userId: input.userId };
}

export async function resetUserPassword(
  tx: Tx,
  actor: string,
  input: { userId: string; password: string },
): Promise<{ userId: string }> {
  const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!target) throw new DomainError("NOT_FOUND", "That account does not exist.");

  const ctx = await auth.$context;

  // `updatePassword` writes the string it is given VERBATIM — it does NOT hash. Passing the raw
  // password stores it in plain text AND leaves the account unable to sign in, because verification
  // compares against a hash. The same trap as `createUser` not making a credential account.
  await ctx.internalAdapter.updatePassword(input.userId, await ctx.password.hash(input.password));

  // Records THAT the password changed and who changed it, never either value — `isSecretField`
  // nulls both sides. The owner needs to see a reset happened; nobody needs to see what it was.
  await recordEditsFor(tx, actor, {
    tableName: "users",
    recordId: input.userId,
    changes: [{ field: "password", from: null, to: null }],
  });

  // Every existing session is invalidated: a password reset usually means the old one is
  // compromised or the person has left, and leaving their sessions live defeats the point.
  await tx.delete(sessions).where(eq(sessions.userId, input.userId));

  return { userId: input.userId };
}

export async function listStaff(tx: Tx) {
  return tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
}
