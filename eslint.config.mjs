import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated migration SQL and build artefacts.
    "drizzle/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    // T012 — each of these mistakes compiles cleanly and fails at runtime, on the sale path.
    // A lint error is the only thing that catches them before production.
    // See CLAUDE.md § Non-negotiable rules.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm/neon-http",
              message:
                "neon-http cannot run transactions: db.transaction() type-checks and throws " +
                "'No transactions support in neon-http driver' at runtime, on the sale path. " +
                "Use drizzle-orm/node-postgres with pg.",
            },
            {
              name: "drizzle-orm/neon-serverless",
              message:
                "Use drizzle-orm/node-postgres with pg. See CLAUDE.md § Database.",
            },
            {
              name: "@vercel/postgres",
              message:
                "Sunset package — Vercel Postgres no longer exists. Use pg + " +
                "drizzle-orm/node-postgres against the Neon pooled DATABASE_URL.",
            },
            {
              name: "next/cache",
              importNames: ["revalidateTag", "revalidatePath"],
              message:
                "Use updateTag instead. revalidateTag/revalidatePath are stale-while-revalidate " +
                "and would show a cashier pre-sale stock numbers after their own sale. " +
                "See CLAUDE.md § Next.js 16 specifics.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
