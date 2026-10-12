/**
 * The database client (T014).
 *
 * Driver choice is a HARD CONSTRAINT, not a preference (CLAUDE.md § Database):
 *
 *   drizzle-orm/node-postgres + pg  — chosen
 *   drizzle-orm/neon-http           — BANNED. Its db.transaction() type-checks, compiles, and
 *                                     throws "No transactions support in neon-http driver" at
 *                                     runtime, on the sale path. Vercel's own bundled guidance
 *                                     recommends it; that guidance is wrong for this app.
 *   @vercel/postgres                — BANNED. Sunset package.
 *
 * ESLint enforces both bans (eslint.config.mjs).
 *
 * Pool sizing: Fluid Compute runs many invocations per instance, and Neon's pooled endpoint is
 * PgBouncer in transaction mode. `max: 2` with a short idle timeout keeps each instance's
 * footprint small; attachDatabasePool lets Vercel drain connections when an instance is frozen,
 * which is what stops "too many clients" under burst.
 *
 * Module-global and eagerly initialised. NO Proxy wrapper and no lazy getter: both defeat
 * attachDatabasePool's ability to see the pool, and a Proxy additionally breaks instanceof
 * checks inside pg.
 */

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";
import { registerBigIntParser } from "./types";

// Must run before the first query, or BIGINT money comes back as strings.
registerBigIntParser();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Use the POOLED Neon endpoint here (host contains '-pooler'); " +
      "DATABASE_URL_UNPOOLED is for migrations only.",
  );
}

export const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 5_000,
});

// Lets the platform drain idle connections when the instance is suspended.
attachDatabasePool(pool);

export const db = drizzle(pool, { schema });

export type Database = typeof db;

/**
 * The transaction handle type. Every service function that writes takes one of these rather than
 * opening its own transaction, so the idempotency claim and the business write always commit or
 * roll back together (Constitution Principle I).
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export { schema };
