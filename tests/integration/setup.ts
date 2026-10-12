/**
 * Testcontainers harness (T033).
 *
 * Integration tests run against a REAL Postgres 17 with the real migrations applied, because
 * every guarantee in this system is a database guarantee: the guarded conditional UPDATE, the
 * append-only triggers, the unique index that implements idempotency. A mocked database would
 * test nothing that matters.
 *
 * The important and easily-missed piece is `distinctConnection()`. Concurrency tests MUST use
 * separate physical connections — two queries on one pooled client are serialised by the client
 * itself, so a "concurrency" test written that way passes vacuously no matter how broken the
 * locking is. See the negative control in the oversell suite.
 */

import { inject } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import { registerBigIntParser } from "@/lib/db/types";

registerBigIntParser();

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | undefined;
let database: TestDb | undefined;
const extraPools: Pool[] = [];

function uri(): string {
  const value = inject("integrationDatabaseUri");
  if (!value) {
    throw new Error(
      "No integration database. tests/integration/global-setup.ts should have started one.",
    );
  }
  return value;
}

export async function startTestDatabase(): Promise<TestDb> {
  if (database) return database;
  // Migrations were already applied once by the global setup.
  pool = new Pool({ connectionString: uri(), max: 5 });
  database = drizzle(pool, { schema });
  return database;
}

export function getTestDb(): TestDb {
  if (!database) throw new Error("startTestDatabase() has not been called");
  return database;
}

export function getConnectionUri(): string {
  return uri();
}

/**
 * A SEPARATE physical connection, for genuine concurrency tests.
 *
 * Each returned client has its own TCP connection to Postgres, so two of them really can be
 * inside overlapping transactions. Using the shared pool instead would let the client serialise
 * the statements and the test would prove nothing.
 */
export async function distinctConnection(): Promise<TestDb> {
  const p = new Pool({ connectionString: uri(), max: 1 });
  // Force the connection open now, so barrier timing in the test measures the query, not the
  // TCP handshake and authentication.
  await p.query("SELECT 1");
  extraPools.push(p);
  return drizzle(p, { schema });
}

/** Tables in dependency order; TRUNCATE ... CASCADE also bypasses the append-only triggers. */
const TRUNCATABLE = [
  "stock_movements",
  "sale_lines",
  "sales",
  "funding_allocations",
  "cash_events",
  "capital_events",
  "batches",
  "products",
  "quality_grades",
  "vendors",
  "idempotency_keys",
  "sessions",
  "accounts",
  "verifications",
  "users",
];

export async function truncateAll(): Promise<void> {
  if (!pool) throw new Error("startTestDatabase() has not been called");
  await pool.query(
    `TRUNCATE ${TRUNCATABLE.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  // RESTART IDENTITY resets per-table identity columns but NOT a standalone sequence, so sale
  // numbers would carry over between tests and break isolation.
  await pool.query("ALTER SEQUENCE sale_number_seq RESTART WITH 1");
}

/** Closes this file's pools. The CONTAINER outlives it and is stopped by the global teardown. */
export async function stopTestDatabase(): Promise<void> {
  await Promise.all(extraPools.map((p) => p.end().catch(() => undefined)));
  extraPools.length = 0;
  await pool?.end().catch(() => undefined);
  pool = undefined;
  database = undefined;
}
