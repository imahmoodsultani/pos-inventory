/**
 * Runs in every worker BEFORE any test module is imported.
 *
 * Most services take an executor and so never touch the module-global pool. Better Auth cannot:
 * its Drizzle adapter is constructed with a concrete `db` at import time, so anything that
 * reaches lib/auth/config — staff accounts, sessions — needs `lib/db` to be connectable.
 *
 * Pointing DATABASE_URL at the test container is the honest fix. The alternative, mocking the
 * auth module, would mean the password-hashing path is never exercised — and that is precisely
 * the path that silently produced unusable accounts earlier in this project.
 */

import { inject } from "vitest";

const uri = inject("integrationDatabaseUri");
if (!uri) {
  throw new Error(
    "No integration database URI. tests/integration/global-setup.ts should have provided one.",
  );
}

process.env.DATABASE_URL = uri;
process.env.DATABASE_URL_UNPOOLED = uri;
// Better Auth refuses to initialise without these; the values only have to be present.
process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-not-used-outside-tests";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
