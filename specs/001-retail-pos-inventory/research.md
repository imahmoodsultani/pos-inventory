# Phase 0 Research: Retail POS with Batch-Level Inventory

**Feature**: `001-retail-pos-inventory` | **Date**: 2026-10-09
**Input**: [spec.md](./spec.md), [constitution](../../.specify/memory/constitution.md)

All versions below were verified against live registries and official documentation on 2026-10-09.
Where current reality contradicts widely-held assumptions, it is flagged explicitly — several of these
would have produced a broken application if taken from memory.

---

## D1. Database provisioning

**Decision**: Neon Postgres, installed through the Vercel Marketplace (`vercel install neon`). Use the
pooled `DATABASE_URL` at runtime and `DATABASE_URL_UNPOOLED` for migrations. Enable Neon's per-preview
database branching.

**Rationale**: Constitution requires a managed, connection-pooled, Vercel-reachable Postgres, and
separate preview and production databases. Neon's Vercel-native integration injects both pooled and
unpooled connection strings and creates a copy-on-write branch per preview deployment, which satisfies
the separation requirement without manual provisioning.

**⚠️ Contradicts common assumption**: **Vercel Postgres no longer exists.** Existing databases were
migrated to Neon in December 2024 and `@vercel/postgres` is a sunset package. Postgres is now
Marketplace-only (Neon, Supabase, Prisma Postgres, AWS Aurora). Any guidance saying "use Vercel
Postgres" or importing `@vercel/postgres` is stale.

**Alternatives considered**: Supabase (bundles auth/storage we don't need; its auth would compete with
our chosen auth library); Prisma Postgres (ties us toward Prisma, rejected in D3); self-hosted
Postgres (violates the managed-database constraint and adds operational burden a single shop cannot
carry).

---

## D2. Database driver — the decision the whole application rests on

**Decision**: `pg` (node-postgres) `8.23.1` + `drizzle-orm/node-postgres`, against Neon's **pooled**
endpoint, with `attachDatabasePool()` from `@vercel/functions`, `max: 2`, `idleTimeoutMillis: 5000`,
module-global pool.

**Rationale**: Constitution Principle I requires a sale to commit atomically with row-level locking so
two cashiers cannot sell the same last unit. That requires an **interactive** transaction — `BEGIN`,
read, *decide based on what was read*, write, `COMMIT`. Only a real TCP/WebSocket connection supports
this.

**⚠️ This is the most dangerous finding in the research.** The Neon **HTTP driver cannot do interactive
transactions**, and the failure mode is silent until runtime:

| Approach | Interactive transaction? | Verdict |
|---|---|---|
| `neon()` HTTP + `drizzle-orm/neon-http` | **No** | Disqualified |
| `sql.transaction([q1, q2])` HTTP batch | **No** — all statements fixed up front | Disqualified |
| Neon WebSocket `Pool` | Yes | Works, not optimal |
| **`pg` TCP pool + `drizzle-orm/node-postgres`** | **Yes** | ✅ Chosen |

`drizzle-orm/neon-http`'s `db.transaction()` **type-checks, autocompletes, compiles, and then throws
`No transactions support in neon-http driver` at runtime** — on the sale path, in production. The
bundled Vercel `vercel-storage` skill's example code recommends exactly this combination; it is correct
for a read-heavy marketing site and wrong for this application. **Do not copy it.**

**⚠️ Second contradiction**: the long-standing advice "on serverless, always use the HTTP driver" is now
**reversed**. Vercel Fluid Compute (default for new projects since 2025-04-23) shares one instance
across concurrent invocations and exposes lifecycle hooks, so `attachDatabasePool` can drain idle
connections before suspension. Neon's own docs now say: *"With Vercel Fluid, we recommend you use a
standard Postgres TCP connection... and a connection pool."* HTTP's only advantage was cold-connection
overhead, which Fluid amortizes to zero on warm instances. We get the correct choice and the fast
choice simultaneously — no tradeoff.

**PgBouncer transaction-mode facts that matter** (Neon's pooled endpoint runs transaction mode):

- ✅ `SELECT ... FOR UPDATE` works correctly — transaction mode pins one backend for the whole
  `BEGIN…COMMIT`, so locks are held properly. The widespread belief that PgBouncer breaks row locking
  is **false**.
- ✅ Protocol-level prepared statements work (distinct from SQL-level `PREPARE`, which does not).
- ❌ `SET`/`RESET`, `LISTEN`/`NOTIFY`, `WITH HOLD` cursors, SQL `PREPARE`, and **session-scoped
  advisory locks** are unsupported. `pg_advisory_lock()` acquired on one backend may be released on
  another — it leaks permanently. **Only `pg_advisory_xact_lock()` is permitted in this codebase.**
- Never place network I/O inside a transaction; it holds a backend connection for its whole life.

---

## D3. ORM

**Decision**: Drizzle ORM `0.45.4` + drizzle-kit `0.31.11`. Stay on the 0.45.x stable line.

**Rationale**: The deciding factor is row locking, not syntax or bundle size. Drizzle exposes
`.for('update' | 'no key update' | 'share' | 'key share')` with `OF`, `NOWAIT`, and `SKIP LOCKED`, fully
typed, plus `db.transaction(fn, { isolationLevel })`. Prisma **cannot express row locks at all** — its
select AST has no field for them (prisma/orm#30531, open since 2021); the only route is `$queryRaw`
inside a transaction, which abandons type safety precisely where correctness matters most. Prisma 8 RC
additionally **removes `isolationLevel` and transaction timeouts**.

**⚠️ Correction to a common assumption**: "Prisma is bad for serverless" is **no longer true** — Prisma
7 removed the Rust engine, cutting the bundle ~85%. Prisma's serverless problem is fixed; its
transaction-primitive problem is not. That, not performance, is why we reject it.

**⚠️ Install footgun**: the `prisma` CLI's npm `latest` tag currently points at `8.0.0-rc.22` while
`@prisma/client` latest is `7.10.0` — a plain install yields mismatched majors. Irrelevant now that we
have chosen Drizzle, but recorded so nobody "fixes" the stack later by installing Prisma casually.

**Do not upgrade to drizzle-orm 1.0 (`rc.5`) during this feature.** Release candidates do not belong
under financial logic.

---

## D4. Framework

**Decision**: Next.js `16.4.0`, App Router, Cache Components enabled, Turbopack (default), React
`19.3.0`, TypeScript.

**Rationale**: Constitution mandates a single TypeScript web application deployable to Vercel from the
repository root. Cache Components' defaults suit this app exactly: **data fetching is dynamic by
default**, and you opt *into* caching per page/component/function. For an app where almost every read is
per-user and must show live stock, the correct configuration is close to doing nothing.

**Naming changes that break older guidance**:
- `middleware.ts` is renamed **`proxy.ts`** in v16.
- `experimental.ppr`, `experimental.dynamicIO`, `experimental.useCache` are all folded into
  `cacheComponents`. `unstable_cache()` → `'use cache'`. `dynamic = 'force-dynamic'` is now redundant.
- Edge runtime is effectively deprecated; Cache Components requires Node.js.

**Caching rules adopted for this feature**:
- **No `'use cache'` on anything transactional** — stock levels, prices, cart state, cash, summary
  figures. All uncached, behind `<Suspense>`.
- `'use cache: private'` is permitted **only** for session/identity. Its default 5-minute browser stale
  window makes it actively wrong for stock numbers.
- After every write, use **`updateTag`, never `revalidateTag`**. `revalidateTag` is
  stale-while-revalidate and does *not* include a re-render in the action's response — the cashier
  would see the pre-sale stock number after their own sale. This is the single most likely correctness
  bug in the app.
- Leave `<Link prefetch>` at default on long lists; Partial Prefetching renders routes at prefetch
  time, costing a server invocation per link.

---

## D5. Mutations

**Decision**: Server Actions for all mutations, each taking an explicit idempotency key as its first
argument, returning typed `{ ok, errors }` via `useActionState` rather than throwing. Route Handlers
reserved for cron endpoints.

**Rationale**: Server Actions return the action result *and* a re-rendered RSC payload in one round
trip, so the new stock number appears without a follow-up fetch — directly serving the sub-1s checkout
target.

**Honest weaknesses, each with a mitigation**:

| Weakness | Mitigation |
|---|---|
| **Next.js provides zero idempotency primitives** | Build it (D7). Non-negotiable, not a later hardening pass. |
| **Action IDs rotate at most every 14 days**, so a till left open across a deploy gets `Failed to find Server Action` | Set a stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; treat this as a routine user-visible retry path, not an edge case. A POS tab stays open all day. |
| **`experimental.useOffline` auto-retries interrupted actions** with no dedup | **Leave off.** On shop wifi it would duplicate sales. Revisit only after idempotency ships. |
| Actions dispatch sequentially per client | Batch all sale lines into one action, never one action per scanned item. |
| Thrown errors become opaque digests in production | Return errors as values; reserve `throw` for genuine 500s. `unstable_rethrow` around any `redirect()` in a `try/catch`. |
| **Every action is a public POST endpoint** | Session + role + ownership checks inside every action (D6). Render-time gating is not a boundary. |

---

## D6. Authentication and authorization

**Decision**: Better Auth `1.7.7` with the Drizzle adapter, email/password, **database sessions in
Postgres**, and a `role` column via `user.additionalFields`. Enforcement via a `server-only` Data Access
Layer plus explicit per-action role checks.

**Rationale**: FR-041 requires two roles with cost/profit/capital invisible to salespeople, and the
constitution requires server-side enforcement. Better Auth is the only option meeting all constraints
natively: built-in credentials (scrypt hashing), real Postgres session table with immediate revocation,
Drizzle adapter, no per-user SaaS cost.

**⚠️ Two findings that eliminate the obvious alternatives**:
- **Lucia is deprecated** — an explicit npm deprecation notice; it is now an educational resource whose
  own maintainers point to Better Auth. "Just use Lucia, it's lightweight" is 2024 advice.
- **Auth.js/NextAuth v5 is still beta after ~3 years** (`5.0.0-beta.32`, `@auth/core` at 0.x), and —
  decisively — **its Credentials provider structurally cannot use database sessions**. It forces
  `strategy: "jwt"`. Our requirement for revocable Postgres sessions rules it out on architecture, not
  preference.
- The bundled `vercel-plugin:auth` skill covers only Clerk, Descope, and Auth0 — all hosted SaaS,
  social/SSO-oriented, with no self-hosted credential story. Not applicable here.

**Enforcement pattern** (from the official Next.js auth guide):
- `proxy.ts` performs **optimistic cookie checks only** — no database calls (it runs on every request
  including prefetches).
- A `server-only` DAL holds `verifySession()`; every data function calls it.
- Every Server Action and Route Handler re-checks session and role. Owner-only operations get an
  explicit role guard inside the action.
- **Never enforce auth in layouts** — they don't re-render on navigation, and hidden children still
  render into the RSC payload.

**Security context**: CVE-2025-29927 was a Next.js middleware authorization bypass via the
attacker-controllable `x-middleware-subrequest` header, affecting versions up to 15.2.3. Next.js 16.4.0
is patched, but the architectural lesson is why the DAL — not the proxy — is our real boundary.

---

## D7. Money representation and cost allocation

**Decision**: `BIGINT` minor units in Postgres; branded `number` in TypeScript; a hand-written ~100-line
`money.ts`. No decimal library.

**Rationale**: Constitution forbids floating-point money. `BIGINT` is exact, 8 bytes, and — unlike
`NUMERIC(12,2)`, which silently rounds half-up on insert — it forces rounding to happen explicitly at
boundaries rather than hiding fractional leakage. `Number.MAX_SAFE_INTEGER` is ~9×10¹⁵ minor units,
roughly ten orders of magnitude above anything a single shop will transact, so native `bigint` (no JSON
serialization, no `Math.*`, ORM friction) is unjustified. Register a `pg` type parser for OID 20 so
BIGINT never leaks as a string.

**Cost allocation — the correctness core of FR-007**. Freight spread across a batch's units must have
per-unit costs that sum back **exactly** to the total. Use cumulative prefix differences, not a
materialized per-unit array:

```
costOfFirst(k) = floor(T * k / N)
costOfUnits(a, b) = costOfFirst(b) - costOfFirst(a)
```

This telescopes to exactly `T` by construction, works for any partial draw in any order, and needs no
remainder bookkeeping. For unequal weights, largest-remainder (Hamilton) allocation with an index
tiebreak for determinism.

**Rounding pitfalls to test explicitly**:
1. Never `Math.round(total / n)` per unit — `round(10/3)*3 = 9 ≠ 10`. This is *the* bug.
2. `Math.floor` vs `Math.trunc` diverge on negatives, and returns make totals negative. Use one
   `floorDiv` everywhere or the refund path won't reconcile with the sale path.
3. Ties must break deterministically by index, or output varies across runs.
4. Never allocate, store a rounded unit cost, then multiply back.

Property-test with `fast-check` `4.10.2`: `∀T, ∀weights → sum(allocate(T, w)) === T`, including negative
totals.

**Alternatives considered**: `dinero.js` 2.0.2 (sound, but adds a dependency for ~100 lines that must be
ours and property-tested); `decimal.js` / `big.js` (unnecessary — no repeating decimals once rounding
happens at boundaries).

---

## D8. Concurrency — preventing the oversold last unit

**Decision**: An atomic **guarded conditional UPDATE** in the same transaction as the ledger insert,
under default `READ COMMITTED`:

```sql
UPDATE batches SET qty_remaining = qty_remaining - $2
 WHERE id = $1 AND qty_remaining >= $2
RETURNING qty_received, qty_remaining, total_cost_minor;
-- rowCount === 0 → insufficient stock → domain error, not a 500
```

**Rationale**: The `UPDATE` takes a row-level exclusive lock. When a second transaction blocks on it and
the first commits, Postgres **re-evaluates the `WHERE` clause against the new row version**
(EvalPlanQual), so the loser matches nothing and returns zero rows. One round trip, no retry loop, no
lost update. A `CHECK (qty_remaining >= 0)` is added as a **backstop**, not the mechanism — alone it
surfaces as SQLSTATE 23514, an ugly 500 instead of "out of stock".

This is simpler than it would otherwise be **because of spec decision FR-018**: the seller names the
batch explicitly, so there is no multi-batch FIFO walk and therefore no deadlock ordering problem.

| Approach | Verdict |
|---|---|
| **Guarded conditional `UPDATE`** | ✅ Chosen — smallest correct thing |
| `CHECK (qty_remaining >= 0)` | ✅ Added as backstop only |
| `SELECT ... FOR UPDATE` | Reserved for decisions spanning multiple rows; requires deterministic `ORDER BY` to avoid deadlocks |
| `SERIALIZABLE` + retry on 40001 | ❌ Overkill; correct only if *every* caller retries |
| Session advisory locks | ❌ Leak under PgBouncer. `pg_advisory_xact_lock` only, for singletons like the nightly reconcile |

**Ledger integrity**: `stock_movements` is append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger
that raises — not by convention. Satisfies Constitution Principle II, with `qty_remaining` as the
permitted reconstructible cache. The reconciliation query (must always return zero rows) runs as an
assertion at the end of every integration test and as a nightly cron.

---

## D9. Idempotency

**Decision**: An `idempotency_keys` table with `UNIQUE (scope, key)`, claimed via
`INSERT ... ON CONFLICT DO NOTHING RETURNING id`, **inside the same transaction as the business write**.

**Rationale**: The unique index *is* the concurrency control. Keeping the key row and the stock movement
in one transaction means a mid-flight crash rolls back both, so the retry is a clean first attempt —
eliminating the recovery-point state machine that Stripe-style designs need. `request_hash` (SHA-256 of
the canonicalized body) is non-negotiable: without it, a client bug reusing a key for a different sale
silently returns the wrong receipt. In-flight duplicate → 409 with `Retry-After`; never block, never
double-execute. 72-hour TTL reaped by cron under `pg_advisory_xact_lock`.

**Key generation**: `crypto.randomUUID()` generated when the sale is *started*, held in a ref, stable
across retries. Generating per submit-attempt would mint a new key per retry and dedupe nothing.

A `UNIQUE (ref_type, ref_id, batch_id)` on `stock_movements` provides a second line of defense at the
database even if the idempotency layer is bypassed.

---

## D10. UI

**Decision**: Tailwind CSS `4.3.3`, shadcn/ui CLI `4.21.4` (Radix default), TanStack Table **v9**
(`9.2.8`), Zod `4.6.5`, `sonner` for toasts.

**Rationale**: Owning component source matters for a dense, keyboard-driven till screen — batch pickers
and data tables need real modification, not override-fighting.

**⚠️ Three things that will not compile if written from memory**:
- **TanStack Table v9 is an API break from v8.** No `useReactTable`; v9 uses `tableFeatures()` to opt
  into sorting/filtering/pagination, plus `createColumnHelper` and `useTable()`. Every v8 blog post and
  snippet is wrong.
- **Zod 4 removed `invalid_type_error` / `required_error`** (unified `error` param) and deprecated
  `.flatten()` / `.format()` in favour of `z.treeifyError()`. **The Next.js forms guide's own Zod
  example is still Zod 3 syntax** and will not work.
- **Radix is now a single unified `radix-ui` package**, not `@radix-ui/react-*`. shadcn CLI v4 removed
  the `--style`, `--base-color`, `--src-dir`, and `--css-variables` flags; passing them errors. Tailwind
  v4 uses `@theme inline` in CSS, not `tailwind.config.ts`.

Use `npx shadcn@latest docs <component>` during implementation rather than recalling APIs.

---

## D11. Testing

**Decision**: Vitest `5.0.3` (unit + integration), `@testcontainers/postgresql` `12.2.0` against
`postgres:17-alpine`, Playwright `1.64.0` (E2E), fast-check `4.10.2` (property tests).

**Rationale**: Constitution requires tests on the sale, stock-movement, and pricing paths covering the
success path, the insufficient-stock path, and the idempotent-replay path. Those are database-behaviour
guarantees — mocks cannot prove them, so integration tests run against real Postgres. Testcontainers is
chosen over a GitHub Actions `services:` block because the latter doesn't exist locally, so developers
would run a different setup than CI. One container in `globalSetup`, migrated once into a template
database, then `CREATE DATABASE ... TEMPLATE` per worker (~50ms, true isolation, keeps parallelism).

**⚠️ Vitest 5 requires Node `^22.12 || ^24 || >=26`** — pin CI and Vercel Node accordingly. Mock clearing
is now on by default and unawaited async assertions now fail.

**The concurrency test must be built correctly or it is theatre**. `Promise.all` over a shared pool
serializes naturally and passes even against broken code. Requirements: N distinct `Client` connections
aligned at a **barrier** so every transaction is open before any contends; repeat 25–50 times; assert
not only "exactly one winner" but that **losers got a clean domain result, not SQLSTATE 23514 or
40001** (a constraint violation escaping means the backstop is doing the mechanism's job); and include a
**negative control** — the same test against a deliberately broken read-then-write must *oversell*, or
the harness isn't creating contention.

**Known gap**: Testcontainers connects directly, bypassing PgBouncer, so it cannot catch pooler
incompatibilities. Mitigate with a CI lint banning `pg_advisory_lock`, bare `SET`, `LISTEN`, and SQL
`PREPARE`.

---

## D12. Migrations and deployment

**Decision**: `drizzle-kit generate` committed as SQL; applied via a dedicated CI step against
`DATABASE_URL_UNPOOLED`, gated to production, decoupled from the build; cutover via `vercel promote`.

**Rationale**: Constitution requires versioned, checked-in, forward-only migrations applied to preview
before production. Migrations must use the **direct** connection — DDL and session-dependent tooling
combine badly with transaction pooling.

**Critical**: `vercel rollback` reverts code but **not schema**. Therefore all migrations are
expand/contract: add columns nullable → deploy code → backfill → drop in a later release. A failed
migration must never take the shop offline mid-trading.

Previews often share the production `DATABASE_URL`; an ungated build-time migration would mutate
production from a feature branch. Neon preview branching plus a `VERCEL_ENV === 'production'` gate
prevents this. Note that `drizzle-kit` and `tsx` do **not** auto-load `.env.local` — use
`dotenv -e .env.local --`.

---

## Resolved unknowns

| Unknown from Technical Context | Resolution |
|---|---|
| Postgres provider and provisioning | D1 — Neon via Marketplace |
| Driver supporting interactive transactions | D2 — `pg` + node-postgres; **never neon-http** |
| ORM with typed row locking | D3 — Drizzle 0.45.4 |
| Framework version and caching posture | D4 — Next.js 16.4.0, Cache Components, nothing transactional cached |
| Mutation mechanism and its risks | D5 — Server Actions + mandatory idempotency |
| Credential auth with Postgres sessions and 2 roles | D6 — Better Auth 1.7.7 |
| Money type and exact cost allocation | D7 — BIGINT minor units, prefix-difference allocation |
| Oversell prevention | D8 — guarded conditional UPDATE |
| Idempotency design | D9 — unique key claimed in-transaction |
| UI libraries and current APIs | D10 — Tailwind 4, shadcn v4, TanStack Table v9, Zod 4 |
| Test stack and real-Postgres strategy | D11 — Vitest 5 + Testcontainers + Playwright |
| Migration and rollback strategy | D12 — expand/contract, direct URL, decoupled promote |

**No NEEDS CLARIFICATION items remain.**
