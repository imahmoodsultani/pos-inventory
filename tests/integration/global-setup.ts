/**
 * ONE Postgres container for the whole integration run.
 *
 * Previously each test file started and stopped its own container: eleven cold Postgres boots
 * per run, ~87s of wall clock, and — observed once — a spurious failure when Docker was under
 * load that vanished on a re-run. A correctness suite that fails at random is worse than a slow
 * one, because it trains you to re-run instead of read.
 *
 * Migrations are applied once here. Per-test isolation still comes from truncateAll(), which is
 * what the tests actually rely on.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

let container: StartedPostgreSqlContainer | undefined;

async function applyMigrations(pool: Pool): Promise<void> {
  const dir = path.resolve(process.cwd(), "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No migrations in ${dir}. Run "npm run db:generate" first.`);
  }

  for (const file of files) {
    // drizzle-kit's own separator — splitting on ";" would break the plpgsql function body.
    const statements = readFileSync(path.join(dir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (error) {
        throw new Error(
          `Migration ${file} failed on:\n${statement.slice(0, 300)}\n\n${String(error)}`,
        );
      }
    }
  }
}

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const uri = container.getConnectionUri();

  const pool = new Pool({ connectionString: uri, max: 1 });
  await applyMigrations(pool);
  await pool.end();

  // `provide` is the supported channel to test workers; environment variables set here are not
  // guaranteed to reach them.
  project.provide("integrationDatabaseUri", uri);
}

export async function teardown(): Promise<void> {
  await container?.stop().catch(() => undefined);
  container = undefined;
}

declare module "vitest" {
  interface ProvidedContext {
    integrationDatabaseUri: string;
  }
}
