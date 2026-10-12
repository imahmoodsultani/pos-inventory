/**
 * Better Auth configuration (T025, D6).
 *
 * Sessions live in Postgres rather than in a stateless JWT, so revoking access is immediate.
 * A JWT would stay valid until expiry, which for a till that a dismissed employee can still
 * reach is not acceptable.
 *
 * Verified against better-auth 1.7.7 as installed, not from memory — the adapter lives in the
 * separate `@better-auth/drizzle-adapter` package, and the option names below were read from
 * `@better-auth/core/dist/db/type.d.mts`.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

/**
 * Origins Better Auth will accept a request from.
 *
 * Better Auth checks the request `Origin` against `baseURL` and rejects a mismatch as CSRF — a
 * failure that surfaces as "sign-in just doesn't work" with no useful error. That bit us twice:
 * once locally (`127.0.0.1` vs `localhost`) and once in production, where one Vercel deployment
 * answers on THREE aliases:
 *
 *   pos-inventory-ochre.vercel.app                     ← the stable production alias
 *   pos-inventory-<team>.vercel.app
 *   pos-inventory-git-<branch>-<team>.vercel.app
 *
 * and every preview deployment invents another. Pinning `baseURL` to one of them means signing
 * in from any other silently fails.
 *
 * The wildcard covers all of them without weakening anything meaningful: it is scoped to this
 * project's own subdomain pattern on vercel.app, not to vercel.app at large.
 */
function trustedOrigins(): string[] {
  const origins = new Set<string>();
  if (process.env.BETTER_AUTH_URL) origins.add(process.env.BETTER_AUTH_URL);
  // Vercel injects this per deployment, without a scheme.
  if (process.env.VERCEL_URL) origins.add(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    origins.add(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.VERCEL) origins.add("https://pos-inventory-*.vercel.app");
  return [...origins];
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  /**
   * Falls back to the deployment URL so a missing BETTER_AUTH_URL degrades to "works on this
   * deployment" rather than "every sign-in fails as CSRF".
   */
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined),
  trustedOrigins: trustedOrigins(),

  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    // Our tables are "users"/"sessions"/"accounts"/"verifications"; Better Auth's models are
    // singular. Without this the adapter looks for a `user` key and finds nothing.
    usePlural: true,
  }),

  emailAndPassword: {
    enabled: true,
    /**
     * NO PUBLIC REGISTRATION.
     *
     * `enabled: true` mounts BOTH /api/auth/sign-in/email and /api/auth/sign-up/email. Left
     * open, anyone on the internet could POST to sign-up, receive a working salesperson
     * account, and reach the till — verified by curl before this line was added.
     *
     * This app has no self-service registration by design: the owner creates staff accounts
     * (spec § Access).
     *
     * NOTE: this flag also disables the SERVER-side `auth.api.signUpEmail()`, not just the HTTP
     * route — verified, after assuming otherwise and watching the seed fail. Accounts are
     * therefore created through `auth.$context.internalAdapter.createUser()` plus
     * `updatePassword()`; see scripts/seed.ts, which is the same path the owner's
     * user-management screen will use.
     */
    disableSignUp: true,
    // No mail server, and nobody to verify against — accounts are created by the owner.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  user: {
    additionalFields: {
      /**
       * FR-041. `input: false` is the load-bearing part: it means a value for `role` is never
       * accepted from the request body. Without it, anyone hitting the sign-up endpoint could
       * post `role: "owner"` and promote themselves — the single most damaging hole this app
       * could ship with. Roles are changed only by an owner through a dedicated action.
       */
      role: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "salesperson",
      },
      /** FR-041a — deactivate, never delete. Also not settable from client input. */
      isActive: {
        type: "boolean",
        required: false,
        input: false,
        defaultValue: true,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 12, // a trading day
    updateAge: 60 * 60, // refresh at most hourly
  },

  advanced: {
    // The till is a long-lived tab; cookies must survive a tab reload but not leave the site.
    defaultCookieAttributes: {
      sameSite: "lax",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    },
  },
});

export type Auth = typeof auth;
