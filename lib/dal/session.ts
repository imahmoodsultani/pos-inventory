import "server-only";

/**
 * THE authorization boundary (T027, D6, Constitution Principle IV).
 *
 * Every Server Action calls verifySession() as its first statement and checks the role as its
 * second. This is not belt-and-braces; it is the only enforcement that exists.
 *
 * WHY NOT A LAYOUT: layouts do not re-render on client-side navigation in the App Router, so a
 * check there runs once and then never again for the rest of the session. An attacker does not
 * navigate anyway — Server Actions are plain POST endpoints reachable with curl, and the action
 * id is in the client bundle. UI that hides a button hides nothing.
 *
 * WHY NOT ONLY proxy.ts: proxy runs before the cache and cannot safely hit the database; it is
 * an optimistic redirect for signed-out users, not a security boundary (see proxy.ts).
 *
 * `import "server-only"` makes importing this from a Client Component a BUILD error, so the
 * session object can never be serialised into the browser bundle.
 */

import { headers } from "next/headers";
import { cache } from "react";

import { auth } from "@/lib/auth/config";

export type Role = "owner" | "salesperson";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
};

export class UnauthenticatedError extends Error {
  readonly code = "UNAUTHENTICATED" as const;
  constructor() {
    super("No valid session");
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(required: Role, actual: Role) {
    super(`Requires role ${required}, session has ${actual}`);
    this.name = "ForbiddenError";
  }
}

/**
 * Returns the current user, or null.
 *
 * `cache()` dedupes this per request, so an action plus several components asking for the
 * session cost one query rather than four. It is per-request memoisation only — it is NOT
 * `'use cache'`, which would be catastrophic for identity.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) return null;

  const user = result.user as unknown as {
    id: string;
    email: string;
    name: string;
    role?: string;
    isActive?: boolean;
  };

  // A deactivated user may still hold a valid session cookie. Treat them as signed out:
  // FR-041a says deactivation takes effect immediately, not at session expiry.
  if (user.isActive === false) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === "owner" ? "owner" : "salesperson",
    isActive: user.isActive ?? true,
  };
});

/** Throws rather than returning null — use at the top of every Server Action. */
export async function verifySession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Require a specific role.
 *
 * Note the deliberate asymmetry: an owner is NOT automatically granted salesperson rights by a
 * hierarchy, because every such hierarchy eventually grants something nobody intended. Actions
 * that both roles may perform call `requireRole("salesperson")`, which accepts either — stated
 * explicitly below rather than implied.
 */
export async function requireRole(required: Role): Promise<SessionUser> {
  const user = await verifySession();
  if (required === "owner" && user.role !== "owner") {
    throw new ForbiddenError(required, user.role);
  }
  // "salesperson" means "any signed-in staff member", which includes the owner.
  return user;
}

export async function requireOwner(): Promise<SessionUser> {
  return requireRole("owner");
}
