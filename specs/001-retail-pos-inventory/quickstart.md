# Quickstart: Retail POS with Batch-Level Inventory

**Feature**: `001-retail-pos-inventory` | **Date**: 2026-10-09

Getting from an empty repo to a running till. Versions are pinned deliberately — see
[research.md](./research.md) for why each was chosen, and for the traps that make guessing expensive.

---

## Prerequisites

- **Node `^22.12 || ^24 || >=26`** — required by Vitest 5.
- Docker running (Testcontainers spins up real Postgres for integration tests).
- Vercel CLI — **upgrade first**, the local version is well behind:
  ```bash
  npm i -g vercel@latest
  ```

---

## 1. Scaffold

```bash
npx create-next-app@latest . --ts --tailwind --eslint --app --turbopack
# Cache Components and Turbopack are defaults in Next.js 16 — no flags needed
```

```bash
npx shadcn@latest init -d        # -d is required; -y alone still prompts
npx shadcn@latest add button dialog table form input select sonner
```

> **Do not pass `--style`, `--base-color`, `--src-dir`, or `--css-variables`** — removed in shadcn CLI
> v4; they now error. Tailwind v4 configures via `@theme inline` in CSS, not `tailwind.config.ts`.

---

## 2. Dependencies

```bash
npm i drizzle-orm@0.45.4 pg@8.23.1 @vercel/functions better-auth@1.7.7 zod@4.6.5 \
      @tanstack/react-table@9.2.8
npm i -D drizzle-kit@0.31.11 @types/pg vitest@5.0.3 @testcontainers/postgresql@12.2.0 \
      @playwright/test@1.64.0 fast-check@4.10.2 dotenv-cli
```

> **Never install `@vercel/postgres`** — sunset package; Vercel Postgres no longer exists.
> **Never import `drizzle-orm/neon-http`** — its `db.transaction()` compiles fine and throws at runtime.

---

## 3. Database

```bash
vercel link
vercel install neon              # provisions Neon, injects env vars, pulls .env.local
```

Injected: `DATABASE_URL` (pooled, `-pooler` host) and `DATABASE_URL_UNPOOLED` (direct).

```ts
// lib/db/index.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { attachDatabasePool } from '@vercel/functions';
import * as schema from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // POOLED
  max: 2,                                       // let PgBouncer multiplex
  idleTimeoutMillis: 5_000,
});
attachDatabasePool(pool);                       // drains idle conns before Fluid suspends

export const db = drizzle(pool, { schema });
```

> Do **not** wrap `db` in a `Proxy` for lazy init — it breaks libraries that introspect the adapter.
> Keep `max: 2`; `max: 1` serializes concurrent requests on an instance.

Register the money type parser once, so `BIGINT` never leaks as a string:

```ts
import pg from 'pg';
pg.types.setTypeParser(20, (v) => { /* assert safe integer, return Number(v) */ });
```

---

## 4. Migrations

```bash
npx drizzle-kit generate                                  # writes SQL into drizzle/
npx dotenv -e .env.local -- npx drizzle-kit migrate       # applies
```

> `drizzle-kit` and `tsx` do **not** auto-load `.env.local` — only Next.js does. Hence `dotenv -e`.

Rules (Constitution + D12):
- Migrations run against **`DATABASE_URL_UNPOOLED`**, never the pooled endpoint.
- **Never `drizzle-kit push`** against a shared environment.
- Expand/contract only: add nullable → deploy → backfill → drop later. `vercel rollback` reverts code
  but **not** schema.

---

## 5. Configuration

```ts
// next.config.ts
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,   // set explicitly; unset logs a warning
};
```

Caching discipline — the rule that keeps stock numbers true:
- **No `'use cache'` on stock, prices, cash, or summary figures.** Uncached, behind `<Suspense>`.
- `'use cache: private'` for session/identity only (5-min browser stale by default).
- After every write: **`updateTag`**, never `revalidateTag`.

Required env vars:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | runtime / migrations |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | auth |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | **stable across instances**, or open tills break on deploy |
| `CRON_SECRET` | guards cron routes |

Keep `.env.example` current; never commit real values.

---

## 6. Project layout

```
app/
  (auth)/sign-in/
  (app)/
    till/            # record a sale — the critical path
    receiving/       # US1
    inventory/       # US1, stock counts
    capital/         # US3
    summary/         # US4
    reports/         # US5
  api/
    auth/[...all]/
    cron/reconcile/
    cron/reap-idempotency/
lib/
  db/        schema.ts, index.ts
  domain/    money.ts, allocation.ts      ← pure, property-tested
  dal/       session.ts, queries.ts       ← 'server-only'
  services/  sale.ts, receiving.ts, capital.ts   ← transactional use cases
  auth/
proxy.ts     # NOT middleware.ts — renamed in Next.js 16
tests/
  unit/ integration/ e2e/
drizzle/     # committed migration SQL
```

---

## 7. Verify it works

```bash
npm run dev
npm run test:unit          # money/allocation property tests
npm run test:integration   # real Postgres via Testcontainers
npm run test:e2e
```

**Smoke path** — exercises the whole system end to end:

1. Sign in as owner → record a capital injection.
2. Create a vendor, a quality grade, a product.
3. Receive 20 units from Vendor A grade A; fund fully from new capital.
4. Receive 15 units of the **same product** from Vendor B grade B at a different rate.
5. Open the till → confirm **both batches appear separately** and you must pick one.
6. Sell 3 units from Batch A → confirm only Batch A decremented, and the sale shows Vendor A's cost.
7. Open the summary → check `identityHolds === true`:
   `invested − recovered + profit = cash + inventory at cost`.
8. Submit the same sale twice with the same idempotency key → exactly **one** sale recorded.

---

## 8. Deploy

```bash
vercel                   # preview — gets its own Neon branch
vercel promote <url>     # production cutover, separate from migration
```

Migrations run as their own CI step against `DATABASE_URL_UNPOOLED`, gated to
`VERCEL_ENV === 'production'`, **before** promoting. Previews frequently share the production
`DATABASE_URL` — an ungated build-time migration would mutate production from a feature branch.

---

## Pitfalls that will cost you a day

| Symptom | Cause |
|---|---|
| `No transactions support in neon-http driver` at runtime | Imported `drizzle-orm/neon-http`. Use `node-postgres`. |
| Cashier sees pre-sale stock after their own sale | Used `revalidateTag` instead of `updateTag`. |
| `Failed to find Server Action` on a till open all day | Action IDs rotate ≤14 days. Set a stable encryption key and build a retry path. |
| Duplicate sales on flaky wifi | `experimental.useOffline` enabled before idempotency shipped. Leave it off. |
| Advisory lock never releases | Used `pg_advisory_lock` (session-scoped) under PgBouncer. Only `pg_advisory_xact_lock`. |
| Per-unit costs don't sum to batch total | Rounded per unit. Use prefix differences, never `Math.round(total/n)`. |
| Concurrency test passes against broken code | No barrier; ops serialized. Add the negative control. |
| TanStack Table / Zod snippets won't compile | v8 / Zod 3 syntax from older sources. v9 and Zod 4 are API breaks. |
