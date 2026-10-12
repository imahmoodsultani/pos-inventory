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
  _actor: string,
  input: { userId: string; password: string },
): Promise<{ userId: string }> {
  const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!target) throw new DomainError("NOT_FOUND", "That account does not exist.");

  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(input.userId, input.password);

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
