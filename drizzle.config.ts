import { defineConfig } from "drizzle-kit";

/**
 * T010. Migrations run against DATABASE_URL_UNPOOLED — the DIRECT endpoint, never the pooled one.
 *
 * PgBouncer in transaction mode multiplexes backends between statements, so DDL that depends on
 * session state (advisory locks, SET, PREPARE) behaves unpredictably through the pooler. The
 * running app uses the pooled URL; migrations must not.
 */
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED!,
  },
  strict: true,
  verbose: true,
});
