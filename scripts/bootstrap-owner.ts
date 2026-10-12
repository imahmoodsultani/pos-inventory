/**
 * Creates the FIRST production owner.
 *
 * Chicken-and-egg: public sign-up is disabled and staff accounts are created by an owner, so the
 * very first owner has to come from outside the app. This is that one-time bootstrap.
 *
 * Goes through Better Auth's internal adapter so the password is hashed by the same code that
 * verifies it at sign-in — hand-rolling a hash is how a seeded account ends up unable to log in.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth/config";
import { db, pool } from "@/lib/db";
import { users } from "@/lib/db/schema";

const EMAIL = process.env.BOOTSTRAP_OWNER_EMAIL!;
const OUT = process.env.BOOTSTRAP_OUT!;

async function main() {
  const existing = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log("An account with that email already exists — nothing created.");
    return;
  }

  const password = randomBytes(18).toString("base64url");
  const ctx = await auth.$context;

  const created = await ctx.internalAdapter.createUser(
    { email: EMAIL, name: "Owner", role: "owner", isActive: true },
    { method: "admin" },
  );
  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await ctx.password.hash(password),
  });

  // Prove it can actually authenticate before reporting success.
  const credential = await ctx.internalAdapter.findCredentialAccount(created.id);
  if (!credential?.password) throw new Error("No credential account — the user cannot sign in.");

  writeFileSync(
    OUT,
    `PRODUCTION OWNER — created ${new Date().toISOString()}\n\n` +
      `URL:      https://pos-inventory-ochre.vercel.app/sign-in\n` +
      `Email:    ${EMAIL}\n` +
      `Password: ${password}\n\n` +
      `Change this from Staff → after signing in, then delete this file.\n`,
    { mode: 0o600 },
  );
  console.log("Created. Credentials written to", OUT);
}

main()
  .catch((e) => {
    console.error("Failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
