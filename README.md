# POS & Inventory

A single-store retail point of sale where **every unit of stock carries the vendor, quality grade,
and cost of the batch it arrived in**. Each sale records exact cost of goods sold and profit, and
the owner can see capital invested, capital recovered, cash, and unsold inventory at any moment.

Built with Next.js 16 (App Router, Cache Components), Postgres via Drizzle, and Better Auth.

---

## Getting started

```bash
nvm use                      # Node 22.23.3, pinned in .nvmrc
npm ci
cp .env.example .env.local   # then fill it in — see below
npm run db:migrate
npx dotenv -e .env.local -- npx tsx scripts/seed.ts
npm run dev
```

### Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Pooled** endpoint (host contains `-pooler`). Used by the running app. |
| `DATABASE_URL_UNPOOLED` | **Direct** endpoint. Migrations only — never the app. |
| `BETTER_AUTH_SECRET` | Session signing. `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Must match the origin users actually hit, **exactly**. A mismatch (`127.0.0.1` vs `localhost`) makes every sign-in fail as CSRF. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Must be **stable across deploys**, or a till left open all day breaks on every release. |
| `CRON_SECRET` | Bearer token for the two cron routes. |

A local Postgres for development:

```bash
docker run -d --name pos-inventory-dev-db \
  -e POSTGRES_PASSWORD=devpassword -e POSTGRES_USER=posdev -e POSTGRES_DB=pos_inventory \
  -p 5433:5432 postgres:17-alpine
```

### Tests

```bash
npm run test:unit         # pure money/allocation, property-tested with fast-check
npm run test:integration  # real Postgres 17 via Testcontainers — needs Docker running
npm run test:e2e          # Playwright, desktop + 1024px tablet
```

---

## Non-negotiable rules

These are correctness constraints for a system that handles money and stock. Each was researched
and decided — see `specs/001-retail-pos-inventory/research.md`. Do not "simplify" past them.

### Database

- **Never import `drizzle-orm/neon-http`.** Its `db.transaction()` type-checks, compiles, and throws
  at runtime — on the sale path. Use `drizzle-orm/node-postgres` with `pg`. ESLint blocks it.
- **Never install `@vercel/postgres`.** Sunset package.
- Runtime uses the **pooled** URL; migrations use the **unpooled** one.
- **Only `pg_advisory_xact_lock`.** The session-scoped variant leaks permanently under PgBouncer.
- **No network I/O inside a transaction** — it holds a backend for the whole duration.

### Money

- `BIGINT` minor units in Postgres, branded `Minor` in TypeScript. No floats, ever.
- **Never `Math.round(total / n)` for a unit cost.** Prefix-difference allocation only, so per-unit
  costs sum back to the total exactly.
- One shared `floorDiv` — `Math.floor` and `Math.trunc` diverge on negatives.

### Concurrency

- Oversell is prevented by the **guarded conditional UPDATE** (`WHERE id = ? AND qty_remaining >= ?`,
  checking `rowCount === 0`). `CHECK (qty_remaining >= 0)` is a **backstop**; SQLSTATE 23514 reaching
  a caller is a bug.
- `stock_movements`, `capital_events`, and `cash_events` are **append-only by trigger**.
  `sales`, `sale_lines`, `batches`, and `funding_allocations` are **delete-protected only** —
  their columns legitimately advance.
- Every mutation takes an `idempotencyKey` first, claimed **inside the business transaction**.

### Next.js 16

- The file is **`proxy.ts`**, not `middleware.ts`. It is an optimistic redirect, **not** the
  security boundary — and it excludes all of `/api`, or cron would be redirected to sign-in.
- After a write use **`updateTag`**, never `revalidateTag`.
- **No `'use cache'` on anything transactional.** Authenticated pages set `export const instant = false`.
- Auth is enforced in a `server-only` DAL and re-checked in every Server Action. **Never in layouts.**
- `experimental.useOffline` stays **off** — it auto-retries actions and would duplicate sales.

### The invariants

Asserted after every integration test and nightly in cron:

- **A** — `batches.qty_remaining` reconstructs from `stock_movements`.
- **B** — `capital_invested − capital_recovered + profit = cash_on_hand + inventory_at_cost`, exact.
- **C** — a depleted batch's outbound movement costs sum to `total_cost_minor`.

---

## Deployment

```bash
vercel link
vercel install neon          # provisions Postgres; sets both URLs
vercel --prod
```

**Preview and production must not share a database.** Enable Neon's Vercel preview-branch
integration — the default is to inherit the production URL, so this must be configured, not assumed.

Migrations run against `DATABASE_URL_UNPOOLED` **before** promote. `vercel rollback` reverts code
but not schema, so use expand/contract migrations only.

### Cron

Two jobs in `vercel.json`, both daily — **exactly at the Hobby-plan limit** (max 2 jobs, minimum
once per day). Adding a third, or tightening either schedule, requires Pro.

| Route | Schedule | Purpose |
|---|---|---|
| `/api/cron/reconcile` | `0 2 * * *` | Invariants A/B/C; returns 500 and logs an error if any fails |
| `/api/cron/reap-idempotency` | `30 2 * * *` | Deletes expired keys in batches |

Cron runs only on **production** deployments, never previews.

### CI secrets

`.github/workflows/deploy.yml` needs two repository secrets:

| Secret | Where from |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens |
| `DATABASE_URL_UNPOOLED` | The **direct** Neon endpoint, not the `-pooler` one |

Migrations run **before** promote. `vercel rollback` reverts code but not schema, so migrations
must be expand/contract — additive and tolerated by the previous release.
