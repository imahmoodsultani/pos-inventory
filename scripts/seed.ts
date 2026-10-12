/**
 * Development seed (T037).
 *
 * Creates one owner, one salesperson, three quality grades, and two vendors so the app is
 * usable the moment migrations land.
 *
 * Users are created THROUGH Better Auth's sign-up API rather than by inserting rows, so the
 * password is hashed by the same code path that verifies it at sign-in. Inserting a hash by
 * hand is how seeded accounts end up unable to log in.
 *
 * Credentials come from .env.local. Nothing is hardcoded and nothing is printed.
 *
 * Run: npx dotenv -e .env.local -- npx tsx scripts/seed.ts
 */

import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth/config";
import { db, pool } from "@/lib/db";
import { qualityGrades, users, vendors } from "@/lib/db/schema";

const SEED_ACTOR = "seed";

type SeedUser = {
  email: string;
  name: string;
  password: string;
  role: "owner" | "salesperson";
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env.local before seeding — the seed never invents ` +
        `credentials, so that a development password can never silently become a real one.`,
    );
  }
  return value;
}

/**
 * Create a user without going through the public sign-up endpoint.
 *
 * `emailAndPassword.disableSignUp` turns off `auth.api.signUpEmail()` as well as the HTTP
 * route, so account creation goes through Better Auth's internal adapter. The password is still
 * hashed and stored by Better Auth's own code, which is the part that matters — hand-rolling a
 * hash is how seeded accounts end up unable to sign in.
 */
async function createUser(spec: SeedUser): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, spec.email)).limit(1);
  if (existing.length > 0) {
    console.log(`· ${spec.role} ${spec.email} already exists, skipping`);
    return;
  }

  const ctx = await auth.$context;

  const created = await ctx.internalAdapter.createUser(
    {
      email: spec.email,
      name: spec.name,
      // Set directly here because it CANNOT come from request input (input: false, FR-041).
      // Server-side assignment by an owner is the only way a role is ever set.
      role: spec.role,
      isActive: true,
    },
    // Provisioning source. "admin" is accurate: these accounts are created by an owner, not by
    // self-registration — which is disabled entirely (lib/auth/config.ts).
    { method: "admin" },
  );

  /**
   * `createUser` does NOT create a credential account, and `updatePassword` only UPDATES an
   * existing one — so calling it here silently does nothing and leaves an account that can
   * never sign in, while the seed happily reports success. The credential row has to be
   * created explicitly.
   *
   * `providerId: "credential"` and `accountId = user.id` are what Better Auth's email/password
   * sign-in looks up (`findCredentialAccount` matches the account whose local subject is the
   * user id). Hashing goes through ctx.password.hash so sign-in verifies with the same
   * algorithm and parameters.
   */
  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await ctx.password.hash(spec.password),
  });

  // Prove the account can actually authenticate. The previous version of this function reported
  // success for accounts with no credential row at all; a seed that lies is worse than one that
  // fails.
  const credential = await ctx.internalAdapter.findCredentialAccount(created.id);
  if (!credential?.password) {
    throw new Error(
      `Created ${spec.email} but no credential account with a password exists — ` +
        `this account could not sign in.`,
    );
  }

  console.log(`✓ created ${spec.role} ${spec.email}`);
}

async function main(): Promise<void> {
  const seedUsers: SeedUser[] = [
    {
      email: requireEnv("SEED_OWNER_EMAIL"),
      password: requireEnv("SEED_OWNER_PASSWORD"),
      name: "Store Owner",
      role: "owner",
    },
    {
      email: requireEnv("SEED_SALESPERSON_EMAIL"),
      password: requireEnv("SEED_SALESPERSON_PASSWORD"),
      name: "Salesperson",
      role: "salesperson",
    },
  ];

  for (const spec of seedUsers) {
    await createUser(spec);
  }

  await db
    .insert(qualityGrades)
    .values([
      { code: "A", label: "Premium", sortOrder: 1, createdBy: SEED_ACTOR },
      { code: "B", label: "Standard", sortOrder: 2, createdBy: SEED_ACTOR },
      { code: "C", label: "Economy", sortOrder: 3, createdBy: SEED_ACTOR },
    ])
    .onConflictDoNothing();
  console.log("✓ quality grades A/B/C");

  // vendors is unique on lower(name) — an EXPRESSION index, which drizzle's typed `target`
  // cannot express. Bare onConflictDoNothing() emits `ON CONFLICT DO NOTHING` with no inference
  // clause, which covers any constraint including this one, and is exactly what re-running the
  // seed needs.
  await db
    .insert(vendors)
    .values([
      { name: "Northside Supply", phone: "0300-0000000", createdBy: SEED_ACTOR },
      { name: "Harbour Imports", phone: "0300-1111111", createdBy: SEED_ACTOR },
    ])
    .onConflictDoNothing();
  console.log("✓ vendors");

  console.log("\nSeed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
