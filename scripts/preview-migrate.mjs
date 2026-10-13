/**
 * Apply migrations to a PREVIEW deployment's own Neon branch, before its build.
 *
 * Constitution: "Migrations MUST be forward-only and MUST be applied to preview before
 * production." That was satisfied only trivially while preview shared the production database —
 * once each preview gets its own branch, a pull request adding a migration would otherwise ship
 * new code onto an un-migrated schema.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS REFUSES TO RUN BY DEFAULT
 *
 * If Neon preview branching is NOT enabled, a preview deployment's DATABASE_URL_UNPOOLED is
 * literally the production one — the integration scopes a single value to all environments. A
 * script that migrated "the preview database" would then migrate PRODUCTION, from a pull request,
 * before anyone reviewed it. That is a far worse failure than not migrating at all.
 *
 * So there are TWO gates, and they are different in kind:
 *
 *   1. ALLOW_PREVIEW_MIGRATIONS — a human asserting that branching is on.
 *   2. PRODUCTION_DB_HOST       — a value this script CHECKS against, which no assertion can fake.
 *
 * The second exists because the first is only a promise. If the branching toggle is off, or is
 * turned off later, or the integration is reconnected and silently reverts, the flag still reads
 * "1" and the migration still lands on production. Comparing the host actually verifies the thing
 * the flag merely claims — and it keeps verifying it on every build, not just the day it was set.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV;

// Production migrates from .github/workflows/deploy.yml, before the build and before promotion —
// never as a side effect of a build. Local and CI builds have no VERCEL_ENV at all.
if (vercelEnv !== "preview") {
  console.log(`[preview-migrate] VERCEL_ENV=${vercelEnv ?? "(unset)"} — nothing to do.`);
  process.exit(0);
}

const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error(
    "[preview-migrate] DATABASE_URL_UNPOOLED is not set on this preview deployment.\n" +
      "Migrations must use the DIRECT endpoint; the pooled one multiplexes backends between\n" +
      "statements and DDL depending on session state behaves unpredictably through it.",
  );
  process.exit(1);
}

if (process.env.ALLOW_PREVIEW_MIGRATIONS !== "1") {
  console.error(
    "[preview-migrate] REFUSING to migrate: ALLOW_PREVIEW_MIGRATIONS is not set to 1.\n" +
      "\n" +
      "Without Neon preview branching enabled, this deployment's DATABASE_URL_UNPOOLED IS the\n" +
      "production database, and migrating it from a pull request is exactly what this guard\n" +
      "exists to prevent.\n" +
      "\n" +
      "Enable branching first:\n" +
      "  Vercel → Storage → your Neon database → Connect Project → Advanced Options\n" +
      "         → Deployments Configuration → toggle Preview\n" +
      "Then set ALLOW_PREVIEW_MIGRATIONS=1 on the Preview environment only.",
  );
  process.exit(1);
}

// Host only — never the credentials.
let host;
try {
  host = new URL(url).host;
} catch {
  console.error("[preview-migrate] DATABASE_URL_UNPOOLED is not a parseable URL.");
  process.exit(1);
}

/**
 * The gate that cannot be fooled by a stale flag.
 *
 * Compared case-insensitively and with the port ignored, because the pooled and direct endpoints
 * of the same Neon branch differ only by a `-pooler` infix and must BOTH be treated as production.
 */
const productionHost = process.env.PRODUCTION_DB_HOST?.trim().toLowerCase();
if (!productionHost) {
  console.error(
    "[preview-migrate] REFUSING to migrate: PRODUCTION_DB_HOST is not set.\n" +
      "\n" +
      "Without it this script cannot tell a preview branch from production, and\n" +
      "ALLOW_PREVIEW_MIGRATIONS is only a promise that branching is enabled — not proof.\n" +
      "\n" +
      "Set PRODUCTION_DB_HOST on the Preview environment to the production database host\n" +
      "(the hostname only, no credentials), e.g. ep-xxxx-123456.us-east-1.aws.neon.tech",
  );
  process.exit(1);
}

const bare = (h) => h.toLowerCase().split(":")[0].replace("-pooler.", ".");
if (bare(host) === bare(productionHost)) {
  console.error(
    `[preview-migrate] REFUSING to migrate: this deployment's database is PRODUCTION (${host}).\n` +
      "\n" +
      "ALLOW_PREVIEW_MIGRATIONS is set, but the connection still points at the production host —\n" +
      "so Neon preview branching is NOT actually in effect for this deployment. Migrating here\n" +
      "would alter the production schema from an unreviewed pull request.\n" +
      "\n" +
      "Check: Vercel → Storage → the Neon database → Connect Project → Advanced Options\n" +
      "       → Deployments Configuration → Preview must be toggled on.",
  );
  process.exit(1);
}

// Logged so the build record shows which database was altered, which is what makes a migration
// auditable after the fact.
console.log(`[preview-migrate] target ${host} differs from production — applying migrations`);

try {
  execFileSync("npx", ["drizzle-kit", "migrate"], {
    stdio: "inherit",
    env: process.env,
  });
} catch {
  // Fail the build. A preview running new code against an old schema is not a preview of
  // anything, and the pull request it belongs to cannot be reviewed as the constitution requires.
  console.error("[preview-migrate] migration failed — failing the build.");
  process.exit(1);
}

console.log("[preview-migrate] done.");
