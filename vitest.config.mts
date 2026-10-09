import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Vitest does not read tsconfig `paths`; the "@/..." alias has to be declared here too or the
// test files resolve against node_modules and fail with "Cannot find package".
const alias = { "@": root.replace(/\/$/, "") };

/**
 * Two projects with very different cost profiles (T006):
 *
 * - `unit`   — pure functions (money, allocation) plus fast-check property runs. No I/O,
 *              so these must stay in the low hundreds of milliseconds.
 * - `integration` — real Postgres via Testcontainers. Pulling and booting postgres:17-alpine
 *              on a cold machine comfortably exceeds Vitest's default 5s timeout, and the
 *              oversell tests deliberately run 25-50 barrier-synchronised repeats.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // A shared container plus guarded conditional UPDATEs means concurrent suites
          // would contend on the same rows. Correctness tests must not race each other.
          fileParallelism: false,
        },
      },
    ],
  },
});
