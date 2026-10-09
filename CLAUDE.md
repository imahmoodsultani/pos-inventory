# pos-inventory Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-10-09

## Active Technologies

- TypeScript 5.x on Node 22.12+ (Vitest 5 requires ^22.12, ^24, or >=26) + Next.js 16.4.0 (App Router, Cache Components, Turbopack), React 19.3.0, (001-retail-pos-inventory)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x on Node 22.12+ (Vitest 5 requires ^22.12, ^24, or >=26): Follow standard conventions

## Recent Changes

- 001-retail-pos-inventory: Added TypeScript 5.x on Node 22.12+ (Vitest 5 requires ^22.12, ^24, or >=26) + Next.js 16.4.0 (App Router, Cache Components, Turbopack), React 19.3.0,

<!-- MANUAL ADDITIONS START -->

## Non-negotiable rules for this codebase

These are correctness constraints for a system that handles money and stock. Each one has already been
researched and decided — see `specs/001-retail-pos-inventory/research.md`. Do not "simplify" past them.

### Database

- **Never import `drizzle-orm/neon-http`.** Its `db.transaction()` type-checks, compiles, and throws
  `No transactions support in neon-http driver` at runtime — on the sale path. Use
  `drizzle-orm/node-postgres` with `pg`. (Vercel's own bundled `vercel-storage` skill recommends
  neon-http; it is wrong for this app.)
- **Never install `@vercel/postgres`.** Sunset package. Vercel Postgres no longer exists.
- Runtime uses the **pooled** `DATABASE_URL`; migrations use `DATABASE_URL_UNPOOLED`.
- `attachDatabasePool(pool)` from `@vercel/functions`, `max: 2`, `idleTimeoutMillis: 5000`,
  module-global, **no `Proxy` wrapper**.
- **Only `pg_advisory_xact_lock`** — session-scoped `pg_advisory_lock` leaks permanently under
  PgBouncer. Also banned: bare `SET`, `LISTEN`, SQL-level `PREPARE`.
- **No network I/O inside a transaction.** It holds a backend connection for the whole duration.

### Money

- `BIGINT` minor units in Postgres, branded `number` in TypeScript. No floats, ever.
- **Never `Math.round(total / n)` to get a unit cost.** Use prefix-difference allocation
  (`floor(T*k/N)` differences) so per-unit costs sum back to the total exactly.
- Use one `floorDiv` everywhere — `Math.floor` and `Math.trunc` diverge on negatives, and returns make
  totals negative.

### Concurrency and correctness

- Oversell is prevented by the **guarded conditional UPDATE**
  (`UPDATE ... WHERE id = ? AND qty_remaining >= ?`), checking `rowCount === 0`. The
  `CHECK (qty_remaining >= 0)` constraint is a backstop; if SQLSTATE 23514 reaches the caller, that is
  a bug.
- `stock_movements` is **append-only**, enforced by trigger. Corrections are reversing rows.
- Every mutation takes an `idempotencyKey` as its **first argument**, claimed via
  `INSERT ... ON CONFLICT DO NOTHING` **inside the same transaction** as the business write.

### Next.js 16 specifics

- The file is **`proxy.ts`**, not `middleware.ts`.
- After a write use **`updateTag`**, never `revalidateTag` — the latter is stale-while-revalidate and
  would show a cashier pre-sale stock numbers after their own sale.
- **No `'use cache'` on anything transactional** (stock, prices, cash, summary). `'use cache: private'`
  is for session/identity only.
- Auth is enforced in a `server-only` DAL and re-checked in every Server Action. **Never in layouts** —
  they don't re-render on navigation.
- Return errors as values via `useActionState`; don't throw for expected failures.
- Leave `experimental.useOffline` **off** — it auto-retries actions and would duplicate sales.

### Libraries where training data is stale

- **TanStack Table v9** — no `useReactTable`; uses `tableFeatures()`, `createColumnHelper`, `useTable()`.
- **Zod 4** — no `invalid_type_error` / `required_error`; use `error` and `z.treeifyError()`.
- **shadcn/ui no longer ships Radix.** Verified 2026-10-09 against CLI 4.21.4: the current registry
  (style `base-nova`) generates components importing **`@base-ui/react`**, and `cn` comes from the
  standalone `cn` package re-exported by `lib/utils.ts` — not from local `clsx` + `tailwind-merge`.
  There is also no `form` component in the registry any more, which suits us: forms here use
  `useActionState`, not react-hook-form. Do not "fix" a Base UI import to `radix-ui`.
- **Tailwind 4** configures via `@theme inline` in CSS.
- Run `npx shadcn@latest docs <component>` instead of recalling APIs.

<!-- MANUAL ADDITIONS END -->
