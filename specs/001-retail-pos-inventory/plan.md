# Implementation Plan: Retail POS with Batch-Level Inventory, Cost Attribution, and Capital Tracking

**Branch**: `001-retail-pos-inventory` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-retail-pos-inventory/spec.md`

## Summary

A single-store retail POS where every unit of stock carries the vendor, quality grade, and cost of the
batch it arrived in, so each sale records exact cost of goods sold and profit, and the owner can see
capital invested, capital recovered, and gross trading profit at any moment.

Technical approach: a Next.js 16 App Router application on Vercel, backed by Neon Postgres. Stock is an
append-only movement ledger with a denormalized `qty_remaining` guarded by an atomic conditional UPDATE
— the mechanism that makes concurrent oversell impossible. Every mutation is a Server Action carrying a
client-generated idempotency key claimed inside the same transaction as the business write. Money is
`BIGINT` minor units throughout, with per-unit costs derived by prefix-difference allocation so they sum
back to the batch total exactly.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22.12+ (Vitest 5 requires ^22.12, ^24, or >=26)
**Primary Dependencies**: Next.js 16.4.0 (App Router, Cache Components, Turbopack), React 19.3.0,
Drizzle ORM 0.45.4 + drizzle-kit 0.31.11, `pg` 8.23.1, Better Auth 1.7.7, Zod 4.6.5,
Tailwind 4.3.3 + shadcn/ui CLI 4.21.4
(TanStack Table was removed during implementation — see the note in
`app/(app)/reports/margin/margin-table.tsx`)
**Storage**: Neon Postgres 17 via Vercel Marketplace. Pooled `DATABASE_URL` at runtime (PgBouncer
transaction mode), direct `DATABASE_URL_UNPOOLED` for migrations. Per-preview Neon branches.
**Testing**: Vitest 5.0.3 (unit + integration), `@testcontainers/postgresql` 12.2.0 against
`postgres:17-alpine`, Playwright 1.64.0 (E2E), fast-check 4.10.2 (property tests)
**Target Platform**: Vercel Fluid Compute (Node.js runtime; Edge explicitly not used)
**Project Type**: Web application — single Next.js app, no separate backend
**Performance Goals**: Checkout path p95 < 1s (constitution); summary and stock reports < 3s at
2,000 products / 200 vendors / 50,000 movements (SC-009)
**Constraints**: Touch-usable at ≤1024px for the sales flow; exact-to-the-minor-unit accounting identity
with zero rounding drift (SC-003); stock must never go negative (SC-007)
**Scale/Scope**: Single store, single currency, 1 owner + a handful of salespeople, 5 user stories,
62 functional requirements, 12 entities

All unknowns resolved in [research.md](./research.md). **No NEEDS CLARIFICATION remain.**

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Initial check — PASS

| Principle | Status | How this design satisfies it |
|---|---|---|
| **I. Transactional Integrity** (NON-NEGOTIABLE) | ✅ | Sale commits sale + lines + movements + cash in one `db.transaction()`. Idempotency key claimed inside that same transaction (D9). Money is `BIGINT` minor units (D7). Oversell blocked by guarded conditional UPDATE (D8). |
| **II. Inventory Is a Ledger** | ✅ | `stock_movements` append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger that raises. `qty_remaining` is the permitted reconstructible cache; Invariant A proves it. |
| **III. Stateless & Deployment-Portable** | ✅ | No in-process state or filesystem writes; env-var config; cron as HTTP Route Handlers, never timers. |
| **IV. Authenticated and Auditable** | ✅ | Better Auth with Postgres sessions; `server-only` DAL plus per-action role checks; `created_by` + server timestamp on every mutating row; `reason` required on adjustments and write-offs by CHECK constraint. |
| **V. Minimum Viable Scope** | ✅ | Scope matches the spec's five stories. Expense tracking, serialization, multi-location, and promotions all explicitly rejected in clarification and listed Out of Scope. |

**Technology & Deployment Constraints**: ✅ Single TypeScript app deployable from repo root; managed
pooled Postgres; versioned checked-in migrations; preview and production databases separated by Neon
branching; touch-usable checkout; errors logged with correlation id and no stack-trace leakage.

### Post-design re-check — PASS

The Phase 1 design strengthened rather than weakened constitutional compliance. Three points worth
recording:

1. **Principle I nearly failed on a technology detail.** The obvious Vercel-native choice — Neon's HTTP
   driver — **cannot execute interactive transactions**, and `drizzle-orm/neon-http`'s `db.transaction()`
   compiles cleanly and throws only at runtime. Choosing `pg` + `node-postgres` (D2) is what makes
   Principle I achievable at all. This is recorded as a hard constraint, not a preference.
2. **Principle II's denormalization allowance is used, and discharged.** `batches.qty_remaining` is a
   cache; Invariant A is asserted at the end of every integration test and nightly in cron.
3. **No complexity deviations.** The Complexity Tracking table below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-retail-pos-inventory/
├── plan.md              # This file
├── spec.md              # Feature specification (62 FRs, 5 user stories)
├── research.md          # Phase 0 — 12 technology decisions
├── data-model.md        # Phase 1 — 11 entities, 3 invariants
├── quickstart.md        # Phase 1 — setup, smoke path, pitfalls
├── contracts/
│   └── server-actions.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

Every path below is named by at least one task in `tasks.md`; the two are kept in sync deliberately.

```text
app/
├── (auth)/sign-in/
├── (app)/
│   ├── layout.tsx                      # shell only — auth is NEVER enforced here
│   ├── till/                           # US2 — record a sale (critical path)
│   ├── sales/[saleId]/                 # US2 — returns and void (salesperson-reachable)
│   ├── receiving/                      # US1 — batches + funding
│   ├── vendors/                        # US1 — vendor catalogue
│   ├── grades/                         # US1 — quality grades
│   ├── inventory/
│   │   ├── stock/                      # US1 — stock on hand
│   │   ├── batches/[batchId]/          # US1 — landed cost, cost correction (FR-007a)
│   │   └── reconciliation/             # Polish — invariant status surface
│   ├── capital/                        # US3 — injections, withdrawals
│   ├── summary/                        # US4 — the headline numbers
│   ├── reports/
│   │   ├── margin/                     # US5 — margin by vendor/grade/product
│   │   └── sales/[saleId]/             # US5 — owner sale detail, frozen attribution
│   └── settings/users/                 # Polish — role administration
├── api/
│   ├── auth/[...all]/
│   ├── cron/reconcile/
│   └── cron/reap-idempotency/
└── layout.tsx

lib/
├── db/          schema.ts, index.ts, types.ts      # Drizzle schema, pooled client, BIGINT parser
├── domain/      money.ts, allocation.ts            # pure, property-tested
├── dal/         session.ts, queries.ts, summary.ts, reports.ts, invariants.ts
│                                                   # 'server-only' — role enforcement by non-selection
├── services/    sale.ts, sale-reversal.ts, receiving.ts, capital.ts,
│                stock-corrections.ts, idempotency.ts, action-wrapper.ts
├── types/       action-result.ts
├── auth/        config.ts
└── logging.ts                                      # correlation ids (FR-044)

components/      ui/ (shadcn), till/ (incl. retry-boundary.tsx), inventory/
proxy.ts         # NOT middleware.ts — renamed in Next.js 16
drizzle/         # committed migration SQL
scripts/seed.ts
vercel.json      # two cron schedules (Hobby limit: 2 jobs, daily minimum)
.github/workflows/   ci.yml (PR gate), deploy.yml
tests/
├── unit/        money, allocation (fast-check)
├── integration/ per-story suites + oversell concurrency, idempotency, invariants, audit trail
└── e2e/         till flow, retry path
```

**Structure Decision**: Single Next.js application (template Option 2 collapsed to one project). Server
Actions are the backend, so a separate `backend/` tree would add a network hop and a second deployable
for no benefit — and the constitution requires one app deployable from the repo root. The meaningful
boundary is `lib/domain` (pure, no I/O) → `lib/services` (transactional) → `lib/dal` (role-filtered
reads) → `app` (UI), not frontend/backend.

## Complexity Tracking

> No constitutional violations. No deviations require justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| *(none)* | — | — |

## Risks

| Risk | Mitigation |
|---|---|
| `drizzle-orm/neon-http` imported by mistake — compiles, throws on the sale path in production | CI lint banning the import; integration tests exercise real transactions |
| `revalidateTag` used instead of `updateTag` — cashier sees pre-sale stock | E2E assertion that stock updates in the same response as the sale |
| Landed cost added after receipt silently breaks the FR-026 funding invariant | Re-balance in the same transaction; dedicated test |
| Concurrency test passes vacuously | Barrier-synchronized distinct connections, 25–50 repeats, plus a negative control that must oversell |
| `Failed to find Server Action` on a till left open across a deploy | Stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; retry path built as a normal flow |
| Gross-profit-only summary misread as net profit | FR-035a labels it explicitly; limitation recorded in Assumptions |
| Capital invested double-counted, breaking SC-003 on the first purchase | Resolved 2026-10-09: invested = injections only (FR-026a, FR-033a). `funding_allocations` is descriptive and feeds no total |
| Cost change after units sold silently breaks the cost-allocation invariant | FR-007a books the whole difference as one zero-quantity adjustment in the same transaction (T046); T039a pins it |
| Preview deployment inherits the production database | T009a configures Neon preview branching and asserts the hosts differ |
| Append-only trigger placed on `funding_allocations`, making every landed-cost call throw | Resolved 2026-10-09: two-tier triggers — `funding_allocations` is delete-protected only, because FR-026 requires T046 to re-balance it (data-model §6) |
| FR-007a adjustment collides with the `(ref_type, ref_id, batch_id)` duplicate-write guard | Resolved 2026-10-09: corrections use `ref_type = 'cost_correction'`, `ref_id = idempotency_keys.id`, so repeat corrections are distinct but true retries still collide |
| `vercel rollback` reverts code but not schema | Expand/contract migrations only; migration decoupled from promote |

## Phase Status

- [x] Phase 0 — research complete, all unknowns resolved → `research.md`
- [x] Phase 1 — design complete → `data-model.md`, `contracts/`, `quickstart.md`
- [x] Initial Constitution Check — PASS
- [x] Post-design Constitution Check — PASS
- [x] Phase 2 — task breakdown complete → `tasks.md` (113 tasks)
- [x] Cross-artifact analysis (`/speckit.analyze`) — 2 critical, 5 high findings
- [x] Clarification session 2 — all 17 findings resolved across spec, data-model, tasks, plan
- [x] Cross-artifact analysis re-run — 8 residual findings (2 high, both self-inflicted) all resolved
