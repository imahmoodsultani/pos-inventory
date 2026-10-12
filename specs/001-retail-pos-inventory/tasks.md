# Tasks: Retail POS with Batch-Level Inventory, Cost Attribution, and Capital Tracking

**Input**: Design documents from `/specs/001-retail-pos-inventory/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/server-actions.md](./contracts/server-actions.md),
[quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included. They are not optional here — SC-003 (zero rounding drift),
SC-007 (stock never negative), and SC-010 (salesperson sees no cost figures) are correctness claims
that cannot be verified by inspection, and plan.md's Risks table names four failure modes that only a
test can catch.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and
demoed independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story the task belongs to (US1–US5)
- Every task names the exact file it touches

## Path Conventions

Single Next.js application at the repository root (plan.md § Structure Decision). No `src/` directory
— `app/`, `lib/`, `components/`, `tests/`, `drizzle/` sit at the root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Get an empty repo to a running, linted, test-capable Next.js 16 app on Neon Postgres.

- [X] T001 Scaffold the app at the repository root with `npx create-next-app@latest . --ts --tailwind --eslint --app --turbopack` (Cache Components and Turbopack are Next.js 16 defaults — pass no extra flags)
- [X] T002 Initialize shadcn/ui with `npx shadcn@latest init -d` then `npx shadcn@latest add button dialog table form input select sonner`; do NOT pass `--style`, `--base-color`, `--src-dir`, or `--css-variables` (removed in CLI v4, they now error)
- [X] T003 [P] Install runtime dependencies at pinned versions: `drizzle-orm@0.45.4 pg@8.23.1 @vercel/functions better-auth@1.7.7 zod@4.6.5 @tanstack/react-table@9.2.8 server-only`
- [X] T004 [P] Install dev dependencies at pinned versions: `drizzle-kit@0.31.11 @types/pg vitest@5.0.3 @testcontainers/postgresql@12.2.0 @playwright/test@1.64.0 fast-check@4.10.2 dotenv-cli`
- [X] T005 Set `cacheComponents: true` and `partialPrefetching: true` explicitly in `next.config.ts` (leaving `partialPrefetching` unset logs a warning); confirm `experimental.useOffline` is absent
- [X] T006 [P] Configure Vitest projects (`unit`, `integration` with a longer timeout for Testcontainers) in `vitest.config.ts`
- [X] T007 [P] Configure Playwright with a `webServer` block against the dev server in `playwright.config.ts`
- [X] T008 [P] Create `.env.example` listing `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `CRON_SECRET` with empty values and a one-line purpose comment each
- [ ] T009 Provision the database: `npm i -g vercel@latest`, then `vercel link` and `vercel install neon`; confirm both `DATABASE_URL` (pooled, `-pooler` host) and `DATABASE_URL_UNPOOLED` land in `.env.local`
- [ ] T009a Enable Neon's Vercel preview-branch integration so every preview deployment gets its own database branch, and verify a preview's injected `DATABASE_URL` host differs from production's. The constitution forbids preview and production sharing a database, and the Vercel default is to inherit the production URL — this must be configured, not assumed
- [X] T010 Create `drizzle.config.ts` pointing `schema` at `lib/db/schema.ts`, `out` at `drizzle/`, and the connection at **`DATABASE_URL_UNPOOLED`** — never the pooled endpoint
- [X] T011 [P] Add npm scripts to `package.json`: `db:generate`, `db:migrate` (via `dotenv -e .env.local --`), `test:unit`, `test:integration`, `test:e2e`, `lint`
- [X] T012 [P] Add a `no-restricted-imports` ESLint rule in `eslint.config.mjs` banning `drizzle-orm/neon-http`, `@vercel/postgres`, and `next/cache`'s `revalidateTag`, each with a message pointing at the correct replacement

**Checkpoint**: `npm run dev` serves a page; `npm run lint` passes; both database URLs are present.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, money arithmetic, auth, idempotency, and the transactional database client. Every
user story reads or writes through this layer.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Database layer

- [X] T013 Define the full Drizzle schema for all 11 entities (`users`, `sessions`, `accounts`, `verifications`, `vendors`, `quality_grades`, `products`, `batches`, `stock_movements`, `sales`, `sale_lines`, `capital_events`, `funding_allocations`, `cash_events`, `idempotency_keys`) per data-model.md §1–§11 in `lib/db/schema.ts`, with every money column as `bigint` and every timestamp as `timestamptz`
- [X] T014 Create the pooled client in `lib/db/index.ts`: `new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 5_000 })`, `attachDatabasePool(pool)`, `drizzle(pool, { schema })` from **`drizzle-orm/node-postgres`**. Module-global, no `Proxy` wrapper, no lazy init
- [X] T015 Register the `BIGINT` (OID 20) type parser in `lib/db/types.ts` so money never leaks to JavaScript as a string; throw if the value exceeds `Number.MAX_SAFE_INTEGER`
- [X] T016 Generate the first migration with `npm run db:generate` into `drizzle/`
- [X] T017 Hand-edit the generated SQL in `drizzle/` to add what drizzle-kit cannot express: `batches.total_cost_minor` as `GENERATED ALWAYS AS (goods_cost_minor + landed_cost_minor) STORED`, `CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received)`, `CHECK (qty_delta <> 0 OR movement_type = 'adjustment')` on `stock_movements` (zero-quantity cost corrections per FR-007a), the `reason IS NOT NULL` check on `adjustment`/`write_off`, `CHECK (unit_of_measure IN ('piece','box','pack','pair'))` on `products` (FR-001 — discrete units only, no weight or length), `UNIQUE (ref_type, ref_id, batch_id)` on `stock_movements`, `UNIQUE (source_type, source_id)` on `cash_events`, `UNIQUE (scope, key)` on `idempotency_keys`, `UNIQUE (lower(name))` on `vendors`, and the role/status `CHECK` constraints
- [X] T018 Add the append-only enforcement to the same migration file in `drizzle/` (data-model.md §6) — database-enforced, not convention. FR-042 covers **every** transactional table, not just movements, but in two tiers: `forbid_mutation()` plus `BEFORE UPDATE OR DELETE` triggers on `stock_movements`, `capital_events`, and `cash_events`; **delete-only** (`BEFORE DELETE`) triggers on `sales`, `sale_lines`, `batches`, and `funding_allocations`, whose columns legitimately change as returns, voids, sales, and cost corrections are recorded. Do **not** put a `BEFORE UPDATE` trigger on `funding_allocations` — FR-026 requires T046 to re-balance the split whenever `total_cost_minor` changes, so an update trigger there would make every `addLandedCost` call throw
- [X] T019 Add the indexes from data-model.md to the migration in `drizzle/`: `batches (product_id, qty_remaining)`, `batches (vendor_id)`, `batches (grade_id)`, `batches (product_id, received_at, id)`, `stock_movements (batch_id, id)`, `idempotency_keys (expires_at)`
- [X] T020 Apply migrations with `npm run db:migrate` and verify the trigger rejects an `UPDATE` on `stock_movements`

### Money and cost allocation (pure, no I/O)

- [X] T021 [P] Implement the branded `Minor` number type, a single shared `floorDiv`, and add/subtract/multiply helpers in `lib/domain/money.ts`; export no function that can produce a float
- [X] T022 [P] Implement `costOfFirst(total, qtyReceived, k)` and `batchCostSlice(total, qtyReceived, consumedBefore, consumedAfter)` by prefix difference in `lib/domain/allocation.ts` — `floor(T*k/N)` differences, never `Math.round(total/n)`
- [X] T023 [P] Write fast-check property tests in `tests/unit/money.test.ts` asserting `floorDiv` agrees with mathematical floor on negative operands, where `Math.trunc` would not
- [X] T024 [P] Write fast-check property tests in `tests/unit/allocation.test.ts` asserting Invariant C: for arbitrary `T`, `N`, and arbitrary chunkings of the draw order, the slices of a fully depleted batch sum to exactly `T`

### Auth and the Data Access Layer

- [X] T025 Configure Better Auth with the Drizzle adapter, Postgres database sessions, and a `role` field via `additionalFields` in `lib/auth/config.ts`; role is server-assigned and never read from client input
- [X] T026 Mount the Better Auth handler at `app/api/auth/[...all]/route.ts`
- [X] T027 Implement `verifySession()` and `requireRole(role)` in `lib/dal/session.ts` with `import 'server-only'` at the top — this is the authorization boundary, never a layout
- [X] T028 Create `proxy.ts` at the repository root (**not** `middleware.ts` — renamed in Next.js 16) for optimistic redirect of unauthenticated requests only; document in a comment that it is not the security boundary

### Shared action plumbing

- [X] T029 [P] Define `ActionResult<T>` and the `ErrorCode` union exactly as in contracts/server-actions.md in `lib/types/action-result.ts`, plus `ok()` / `err()` constructors
- [X] T030 [P] Implement correlation-id generation and the server-side error logger in `lib/logging.ts`, returning the id to the caller for `INTERNAL` errors without leaking stack traces
- [X] T031 Implement `claimIdempotencyKey(tx, { scope, key, actionName, requestHash })` in `lib/services/idempotency.ts` using `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, returning claim / replay / `IDEMPOTENCY_CONFLICT` / `IN_FLIGHT`; it MUST take the transaction handle so it is claimed inside the business transaction
- [X] T032 Implement the mandatory action preamble helper (session → role → Zod 4 parse with `z.treeifyError()` → transaction + idempotency claim → `updateTag`) in `lib/services/action-wrapper.ts`

### Test harness and invariants

- [X] T033 Build the Testcontainers harness in `tests/integration/setup.ts`: start `postgres:17-alpine`, run the migrations in `drizzle/`, expose a per-test truncate, and expose a factory for **distinct physical connections** (needed for real concurrency tests)
- [X] T034 Implement Invariants A, B, and C as query functions in `lib/dal/invariants.ts` per data-model.md §12, and an `assertInvariants(db)` helper in `tests/integration/invariants.ts` to call at the end of every integration test
- [X] T035 Write `tests/integration/idempotency.test.ts`: same key + same payload replays the stored response and writes nothing twice; same key + different payload returns `IDEMPOTENCY_CONFLICT`; a concurrent duplicate returns `IN_FLIGHT`
- [X] T036 Build the root layout, the `(app)` authenticated layout, and the sign-in page in `app/layout.tsx`, `app/(app)/layout.tsx`, and `app/(auth)/sign-in/page.tsx`; the layout performs no auth check beyond presentation
- [X] T037 Write a seed script in `scripts/seed.ts` creating one owner, one salesperson, three quality grades, and two vendors, reading credentials from `.env.local`

**Checkpoint**: Migrations apply cleanly, unit tests pass, a user can sign in, and the integration
harness starts a real Postgres and asserts all three invariants against an empty database.

---

## Phase 3: User Story 1 — Receive stock into vendor- and quality-specific costed batches (Priority: P1) 🎯 MVP

**Goal**: The owner can maintain a catalogue and record receipts as distinct batches that permanently
carry vendor, quality grade, and cost — the anchor every later figure reads from.

**Independent Test**: Record two receipts of the same product — Vendor A grade A at one rate, Vendor B
grade B at another — and confirm the stock list shows both batches separately with correct remaining
quantities and per-unit costs, and that product on-hand equals the sum of both.

### Tests for User Story 1

- [X] T038 [P] [US1] Integration test in `tests/integration/us1-receiving.test.ts`: two receipts of one product from different vendors/grades produce two batches, neither unit cost changes, and on-hand is the sum
- [X] T039 [P] [US1] Integration test in `tests/integration/us1-landed-cost.test.ts`: adding a landed cost raises the effective per-unit cost proportionally **and re-balances `funding_allocations` in the same transaction** — assert the FR-026 invariant still holds afterwards (plan.md names this as a silent-breakage risk)
- [X] T039a [P] [US1] Integration test in `tests/integration/us1-cost-correction.test.ts` (FR-007a): add a landed cost to a batch **after** some of its units have been sold; assert the already-recorded sale line keeps its original frozen cost, a zero-quantity `adjustment` movement carries exactly `costOfFirst(T_new,N,consumed) − costOfFirst(T_old,N,consumed)`, Invariant C still closes, and Invariant B still holds. Use the worked example in data-model.md §12 (inject 1000 → buy 10 @ 1000 → sell 5 @ 150 → +200 landed) as the fixture
- [X] T039b [P] [US1] Integration test in `tests/integration/us1-backdated-receipt.test.ts`: a receipt dated earlier than the most recent sale is accepted, and the date-ranged summary (FR-034) attributes it to its `received_at` period rather than its entry time — the spec permits backdating, so the reporting consequence must be pinned down
- [X] T040 [P] [US1] Integration test in `tests/integration/us1-referential-guard.test.ts`: deleting a product, vendor, or grade that is referenced returns `CONFLICT` naming the referencing entity, and deactivation succeeds instead
- [X] T041 [P] [US1] Integration test in `tests/integration/us1-stock-count.test.ts`: a physical count generates adjustment movements with a reason and never edits `qty_remaining` directly; a write-off without a reason is rejected by the database `CHECK`, not only by Zod

### Implementation for User Story 1

- [X] T042 [P] [US1] Implement `createProduct`, `updateProduct`, `deactivateProduct` Server Actions in `app/(app)/inventory/actions.ts` (owner only; case-insensitive unique `code` → `CONFLICT`)
- [X] T043 [P] [US1] Implement `createVendor` and `deactivateVendor` Server Actions in `app/(app)/vendors/actions.ts`
- [X] T044 [P] [US1] Implement `createQualityGrade` Server Action in `app/(app)/grades/actions.ts`
- [X] T045 [US1] Implement `receiveStock(idempotencyKey, input)` in `lib/services/receiving.ts` as one transaction executing the six steps of contracts/server-actions.md § Receiving in order: insert batch → insert `receipt` movement → assert `newCapitalMinor + reinvestedMinor === total_cost_minor` else `FUNDING_MISMATCH` stating the difference → assert `reinvestedMinor` ≤ retained sale proceeds (T077) else `VALIDATION` → insert `funding_allocations` → insert `cash_events` `out`/`purchase_payment` rejecting a negative balance with `INSUFFICIENT_CASH`
- [X] T046 [US1] Implement `addLandedCost(idempotencyKey, input)` and `correctBatchCost(idempotencyKey, input)` in `lib/services/receiving.ts`. Each must, in **one** transaction: change the cost, re-balance the funding allocation, set `is_cost_corrected`, and write the FR-007a zero-quantity `adjustment` movement carrying the difference already attributed to sold units. That movement MUST use `ref_type = 'cost_correction'` and `ref_id = idempotency_keys.id` (data-model.md §5) — reusing `('batch', batchId)` collides with the batch's own receipt row on the `(ref_type, ref_id, batch_id)` unique index. Omitting the adjustment leaves Invariant C failing from this task until the end of the project — it is not deferrable to Phase 7
- [X] T047 [US1] Implement `returnToVendor(idempotencyKey, input)` in `lib/services/receiving.ts` using the guarded decrement, writing a `vendor_return` movement and an `in`/`vendor_refund` cash event whose amount is **derived from the batch's effective unit cost, never accepted as caller input** (FR-023). The input shape takes `{ batchId, quantity, reason }` only — no refund amount — so partial credits are unrepresentable by construction (FR-023a)
- [X] T048 [US1] Implement `recordStockCount` and `recordWriteOff` in `lib/services/stock-corrections.ts`, generating adjustment movements with a mandatory reason
- [X] T049 [US1] Expose the above as Server Actions with the full preamble in `app/(app)/receiving/actions.ts`, calling `updateTag` (never `revalidateTag`) on commit
- [X] T050 [P] [US1] Implement `getStockOnHand({ productId? })` and `getLowStock()` in `lib/dal/queries.ts` — owner-only, uncached, returning batch, vendor, grade, remaining quantity, and derived effective unit cost. `getLowStock()` must treat `reorder_level = 0` as "no reorder level set" and exclude those products; otherwise every product with the default setting reports as low stock forever
- [X] T051 [P] [US1] Build the catalogue management UI (products, vendors, grades) in `app/(app)/inventory/page.tsx` and `components/inventory/`
- [X] T052 [US1] Build the receiving form in `app/(app)/receiving/page.tsx` with `useActionState`, a stable `crypto.randomUUID()` idempotency key generated **once at first render**, and a funding split that shows the running difference before submit
- [X] T053 [US1] Build the stock-on-hand view with per-batch breakdown and the low-stock list in `app/(app)/inventory/stock/page.tsx`, uncached behind `<Suspense>`

**Checkpoint**: Two batches of one product coexist with distinct costs; every batch has a balanced
funding allocation; Invariants A and C hold. US1 is independently demoable.

---

## Phase 4: User Story 2 — Sell items with exact cost and profit attribution (Priority: P2)

**Goal**: Sales draw from an explicitly chosen batch, freeze that batch's vendor, grade, and unit cost
onto the sale line, and can never oversell.

**Independent Test**: With two batches of one product at different costs, record a sale from a chosen
batch at a chosen price; confirm only that batch decremented and the sale shows that batch's vendor,
grade, unit cost, and resulting profit.

### Tests for User Story 2

- [X] T054 [P] [US2] Integration test in `tests/integration/us2-sale.test.ts`: a 3-unit sale drops the chosen batch by 3, leaves the other batch untouched, and records `profit = (price − effective unit cost) × 3`
- [X] T055 [P] [US2] Integration test in `tests/integration/us2-below-cost.test.ts`: a price below cost completes and stores a **negative** profit rather than blocking (FR-017)
- [X] T056 [US2] Concurrency test in `tests/integration/us2-oversell.test.ts`: N concurrent sales of the last unit on **distinct physical connections**, released by a shared barrier, repeated 25–50 times; exactly one succeeds and the rest return `INSUFFICIENT_STOCK`. Assert no `23514` ever reaches the caller — a `CHECK` violation escaping means the guarded UPDATE was bypassed
- [X] T057 [US2] Negative control in `tests/integration/us2-oversell.test.ts`: the same harness run against a deliberately unguarded read-then-write decrement **MUST oversell**. If this control passes, the harness is not actually concurrent and T056 proves nothing
- [X] T058 [P] [US2] Integration test in `tests/integration/us2-returns-voids.test.ts`: a partial return restores units to the original batch at the **original frozen cost**, reduces profit accordingly, and leaves both records visible; a void writes reversing rows and deletes nothing
- [X] T059 [P] [US2] Integration test in `tests/integration/us2-split-batches.test.ts`: a quantity exceeding any single batch splits into multiple sale lines within one sale, each with its own batch and cost (FR-018b)
- [X] T060 [P] [US2] Role test in `tests/integration/us2-salesperson-visibility.test.ts`: every DAL function reachable by a salesperson returns objects with no cost, profit, capital, or cash key present — asserted on the returned shape, not on the rendered UI (SC-010)

### Implementation for User Story 2

- [X] T061 [US2] Implement `recordSale(idempotencyKey, input)` in `lib/services/sale.ts` as one transaction in the contract's exact order: claim key → per line, `UPDATE batches SET qty_remaining = qty_remaining - $qty WHERE id = $batchId AND qty_remaining >= $qty RETURNING qty_received, qty_remaining, total_cost_minor` checking `rowCount === 0` → compute `cost_minor` via `batchCostSlice` → insert `sale_lines` freezing `vendor_id_at_sale`, `grade_id_at_sale`, `unit_cost_minor_at_sale` → insert one `sale` movement per line → insert the `sales` header → insert the `in`/`sale` cash event. **No network I/O inside the transaction**
- [X] T062 [US2] Map `rowCount === 0` to `INSUFFICIENT_STOCK` carrying the available quantity in `lib/services/sale.ts` — a domain error returned as a value, never a thrown 500
- [X] T063 [US2] Implement `recordSaleReturn` (**owner or salesperson**, FR-021) and `recordSaleVoid` (**owner only**, FR-022) in `lib/services/sale-reversal.ts`, writing reversing movements and cash events and advancing `sales.status` through `completed → partially_returned → returned` / `voided`. A salesperson's return result MUST NOT carry the reversed cost or profit
- [X] T064 [US2] Expose `recordSale`, `recordSaleReturn`, and `recordSaleVoid` as Server Actions in `app/(app)/till/actions.ts`; **all basket lines in one action call** — one action per scanned item would serialize the basket
- [X] T065 [P] [US2] Implement `getStockAvailability()` in `lib/dal/queries.ts` for the till: selects only `batch_id`, vendor, grade, `qty_remaining`, `received_at` — cost columns are **not selected**, not stripped afterwards — and excludes depleted batches
- [X] T066 [US2] Build the till UI in `app/(app)/till/page.tsx` and `components/till/`: basket, per-line price entry, and a mandatory batch picker per line showing vendor / grade / remaining / received date with no cost figures and no default selection
- [X] T067 [US2] Make the till touch-usable at ≤1024px (FR-043) in `components/till/` — large tap targets, no hover-only affordances
- [X] T068 [US2] Implement the `Failed to find Server Action` recovery path as a normal, user-visible retry in `components/till/retry-boundary.tsx`, reusing the same idempotency key so the retry cannot duplicate the sale
- [X] T069 [P] [US2] Build the returns and void screens in `app/(app)/sales/[saleId]/page.tsx`
- [X] T070 [US2] E2E test in `tests/e2e/till.spec.ts`: sign in as salesperson, complete a two-line sale in under 60 seconds (SC-006), and assert the stock figure updates **in the same response** — proving `updateTag` and not `revalidateTag`
- [X] T070a [US2] Latency test in `tests/integration/us2-checkout-p95.test.ts`: measure `recordSale` server-side over at least 200 iterations against the SC-009 data volume and assert **p95 < 1s** — the constitution mandates this and SC-006's 60-second human figure does not cover it

**Checkpoint**: The daily operation works end to end. Oversell is impossible and proven so. A
salesperson can sell without ever receiving a cost figure from the server.

---

## Phase 5: User Story 3 — Fund purchases from new capital, reinvested revenue, or both (Priority: P3)

**Goal**: The owner records money entering and leaving the business, and every purchase declares where
its money came from.

**Independent Test**: Record an injection, a purchase funded from it, a sale, a second purchase funded
part-reinvested and part-new-capital, then a withdrawal; confirm cash on hand, total invested, and
total recovered each move by exactly the expected amounts.

### Tests for User Story 3

- [X] T071 [P] [US3] Integration test in `tests/integration/us3-capital.test.ts`: an injection raises cash on hand and capital invested by the same amount; a withdrawal lowers cash and raises capital recovered
- [X] T072 [P] [US3] Integration test in `tests/integration/us3-funding-split.test.ts` (FR-026a): a mixed-funding purchase leaves capital invested **unchanged** while cash falls by the full cost — the funding split is descriptive and must not move any summary total; a split that does not sum to the total is rejected with the difference stated
- [X] T073 [P] [US3] Integration test in `tests/integration/us3-cash-floor.test.ts`: a withdrawal or purchase payment exceeding cash on hand returns `INSUFFICIENT_CASH` naming the available balance, checked against a balance locked **inside** the transaction rather than read-then-write
- [X] T074 [P] [US3] Integration test in `tests/integration/us3-reinvest-cap.test.ts`: `reinvestedMinor` exceeding retained sale proceeds is rejected (FR-029a); a second purchase may not reinvest proceeds already reinvested by the first

### Implementation for User Story 3

- [X] T075 [US3] Implement `recordCapitalInjection` and `recordWithdrawal` in `lib/services/capital.ts`, each writing a `capital_events` row and its matching `cash_events` row in one transaction
- [X] T076 [US3] Implement the in-transaction cash-floor guard in `lib/services/capital.ts`, reusable by `receiveStock`, that locks and evaluates the derived balance before the debit
- [X] T077 [US3] Implement `getRetainedSaleProceeds()` in `lib/dal/queries.ts` to back the FR-029a reinvestment cap, using the exact formula in data-model.md §9: sale receipts − customer refunds − withdrawals − `Σ funding_allocations.reinvested_minor`. Proceeds, not profit. It must be callable inside the receiving transaction (T045) so the cap is never read-then-write
- [X] T078 [US3] Expose capital actions with the full preamble in `app/(app)/capital/actions.ts`
- [X] T079 [US3] Build the capital and cash screen in `app/(app)/capital/page.tsx`: injection and withdrawal forms, running cash on hand, and the capital-event history

**Checkpoint**: Money in and money out are fully recorded; Invariant B holds across a full
inject → buy → sell → reinvest → withdraw sequence.

---

## Phase 6: User Story 4 — See a complete business summary at any time (Priority: P4)

**Goal**: One screen answering the question the owner actually asked.

**Independent Test**: With a known sequence of injections, purchases, sales, and withdrawals, open the
summary and confirm every figure matches a hand calculation and that
invested − recovered + profit = cash + inventory at cost.

### Tests for User Story 4

- [X] T080 [P] [US4] Integration test in `tests/integration/us4-summary.test.ts`: against a scripted history with hand-computed expected values, every summary figure matches exactly and `identityHolds === true`
- [X] T081 [P] [US4] Integration test in `tests/integration/us4-date-range.test.ts`: a date filter recomputes activity figures while cash on hand and inventory at cost continue to report the **current** position
- [X] T082 [P] [US4] Performance test in `tests/integration/us4-scale.test.ts`: with 2,000 products, 200 vendors, and 50,000 stock movements seeded, **both** the summary query and `getStockOnHand` return in under 3 seconds — SC-009 names two screens, not one

### Implementation for User Story 4

- [X] T083 [US4] Implement `getBusinessSummary({ from?, to? })` in `lib/dal/summary.ts` returning `profitToDateMinor`, `capitalInvestedMinor`, `capitalRecoveredMinor`, `cashOnHandMinor`, `inventoryAtCostMinor`, and `identityHolds` computed from Invariant B — surfaced, not assumed. **`capitalInvestedMinor` = `Σ capital_events(injection)` only** (FR-033a); `funding_allocations` contributes nothing. `profitToDateMinor` subtracts write-offs, reversals, **and FR-007a cost-correction adjustments**
- [X] T084 [US4] Compute `inventoryAtCostMinor` as `Σ batchCostSlice(consumed, qtyReceived)` over open batches in `lib/dal/summary.ts` using each batch's **current** `total_cost_minor`, never as `qty_remaining × a rounded unit cost`
- [X] T085 [US4] Build the summary screen in `app/(app)/summary/page.tsx`, uncached behind `<Suspense>`, with the date-range control and current-position figures distinctly labelled
- [X] T086 [US4] Label the profit figure as **trading profit (revenue less cost of goods sold)** with an inline note that operating expenses are not included, in `app/(app)/summary/page.tsx` (FR-035a)
- [X] T087 [US4] Surface a visible warning on the summary when `identityHolds === false` in `app/(app)/summary/page.tsx` — a silent inconsistency is worse than an ugly banner

**Checkpoint**: The owner sees profit, capital invested, capital recovered, cash, and stock value on
one screen in under 5 seconds (SC-002).

---

## Phase 7: User Story 5 — Trace any sold item and compare vendors and quality grades (Priority: P5)

**Goal**: Retrospective attribution per sold unit, rolled up so buying decisions can be made on real
margins.

**Independent Test**: After sales drawn from several vendors and grades, open a past sale and confirm
full per-line attribution, then confirm the margin report's per-vendor and per-grade totals equal the
sum of the matching sale lines.

### Tests for User Story 5

- [X] T088 [P] [US5] Integration test in `tests/integration/us5-frozen-attribution.test.ts`: after a batch cost correction, `getSaleDetail()` **renders** the original frozen vendor, grade, and unit cost for the earlier sale, and the correction appears in that batch's history as a separate adjustment (US5 scenario 3). Scope this to the reporting surface only — T039a already pins the ledger and Invariant C behaviour, and duplicating those assertions here would let the two tests drift apart
- [X] T089 [P] [US5] Integration test in `tests/integration/us5-margin-report.test.ts`: per-vendor, per-grade, and per-product totals each equal the sum of the matching sale lines

### Implementation for User Story 5

- [X] T090 [P] [US5] Implement `getSaleDetail({ saleId })` in `lib/dal/queries.ts`, reading the frozen `*_at_sale` columns rather than joining through to the current batch
- [X] T091 [P] [US5] Implement `getMarginReport({ groupBy, from?, to? })` for `vendor | grade | product` in `lib/dal/reports.ts`, returning revenue, cost, profit, and margin percentage
- [X] T092 [US5] Build the sale-detail view in `app/(app)/reports/sales/[saleId]/page.tsx` showing vendor, grade, unit cost, price, and profit per line as recorded at the time of sale
- [X] T093 [US5] Build the margin report in `app/(app)/reports/margin/page.tsx` using TanStack Table **v9** (`tableFeatures()`, `createColumnHelper`, `useTable()` — there is no `useReactTable` in v9)
- [X] T094 [US5] Build the owner-facing batch cost-correction **screen** in `app/(app)/inventory/batches/[batchId]/page.tsx`, calling the `correctBatchCost` service already built in T046, and showing the resulting adjustment alongside the batch's original cost

**Checkpoint**: Every sold unit is traceable to its vendor, grade, and cost in under 10 seconds
(SC-001). All five stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T095 Implement the nightly reconciliation route at `app/api/cron/reconcile/route.ts`: `Bearer ${process.env.CRON_SECRET}` check first, then Invariants A, B, and C, guarded by `pg_advisory_xact_lock` (**never** session-scoped `pg_advisory_lock` — it leaks permanently under PgBouncer); alert on any non-empty result
- [X] T096 Implement the expired-key reaper at `app/api/cron/reap-idempotency/route.ts`, deleting in batches under the same `CRON_SECRET` check and advisory-transaction lock
- [X] T097 Register both cron jobs in `vercel.json` with daily schedules — exactly two jobs at daily minimum keeps the project inside Hobby-plan limits; note in a comment that crons run only on production deployments
- [X] T098 [P] Audit every DAL function in `lib/dal/` against the data-model.md §14 visibility table and add a test asserting a salesperson's query **omits the hidden columns from the SELECT list** rather than deleting them afterwards
- [X] T098a [P] Add an integration assertion in `tests/integration/audit-trail.test.ts` sweeping `batches`, `stock_movements`, `sales`, `sale_lines`, `capital_events`, `cash_events`, and `funding_allocations` after the full smoke sequence, asserting **no row has a null `created_by` or a client-supplied timestamp** (FR-032, Principle IV). One service forgetting the actor produces exactly the unattributed adjustment this principle exists to prevent
- [X] T099 [P] Implement owner management of salesperson accounts — create, deactivate, reset password — in `app/(app)/settings/users/page.tsx` and `actions.ts`, rejecting deactivation of the last active owner
- [X] T100 [P] Replace every raw error surface with the FR-044 message style ("Only 2 units left in this batch") plus a correlation id across `components/` and `app/`
- [X] T101 [P] Add the reconciliation view proving displayed quantity matches movement history (FR-010) at `app/(app)/inventory/reconciliation/page.tsx`
- [X] T102 Set a stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in Vercel project environment variables for all environments, so a till left open across a deploy does not break
- [X] T103 Add the production migration CI step running against `DATABASE_URL_UNPOOLED`, gated on `VERCEL_ENV === 'production'` and run **before** `vercel promote`, in `.github/workflows/deploy.yml` — previews often share the production `DATABASE_URL`, so an ungated build-time migration would mutate production from a feature branch
- [X] T103a Add the pull-request quality gate in `.github/workflows/ci.yml` running `tsc --noEmit`, `npm run lint`, `npm run test:unit`, and `npm run test:integration` on every PR — the constitution requires type-checking and linting to pass before merge and `main` to stay deployable
- [X] T104 [P] Verify `app/` contains no `'use cache'` on any stock, price, cash, or summary path, and that `'use cache: private'` appears only on session/identity reads
- [ ] T105 Run the quickstart.md § 7 smoke path end to end against a preview deployment and record the result in `specs/001-retail-pos-inventory/quickstart.md`
- [X] T106 [P] Update `README.md` with setup, the non-negotiable rules from `CLAUDE.md`, and the deploy procedure
- [X] T107 [P] Build empty states and first-run guidance for the catalogue, receiving, till, and summary screens so an untrained owner can reach their first recorded sale unaided (SC-008); each empty screen names the next action rather than showing a blank table

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: depends on Foundational only
- **US2 (Phase 4)**: depends on Foundational; needs US1's `receiveStock` to have stock to sell
- **US3 (Phase 5)**: depends on Foundational; US1 already writes `funding_allocations` and
  `cash_events`, so US3 adds injections, withdrawals, and the reinvestment cap on top
- **US4 (Phase 6)**: reads US1–US3 ledgers; meaningless before them
- **US5 (Phase 7)**: reads US2 sale lines; meaningless before US2
- **Polish (Phase 8)**: after the stories you intend to ship

### Within Phase 2 (ordering that matters)

T013 → T016 → T017 → T018 → T019 → T020 (schema before generate before hand-edit before apply).
T021 → T022 (allocation imports `floorDiv`). T031 → T032 (the wrapper calls the claim).
T033 depends on T020, since the harness runs the migration files.

### Within each user story

Services before actions before UI. Tests may be written first; T057 (negative control) must be written
and **seen to fail correctly** alongside T056, not after it.

T094 (cost-correction screen) depends on T046, which now owns the whole transaction including the
FR-007a adjustment. The adjustment deliberately does **not** live in Phase 7: T034 asserts Invariant C
after every integration test, so a Phase 3 cost change without its adjustment would redden the suite
for four phases.

### Parallel Opportunities

- Phase 1: T003, T004, T006, T007, T008, T011, T012 together
- Phase 2: the money pair (T021–T024) is fully independent of the auth chain (T025–T028) and of the
  action plumbing (T029–T030) — three people can work simultaneously
- All `[P]`-marked tests within a story's test block
- Once Phase 2 closes, US1 and the US3 capital services can proceed in parallel; US2 needs US1

---

## Parallel Example: User Story 1

```bash
# Tests first, all independent files:
Task: "Integration test two-vendor batches in tests/integration/us1-receiving.test.ts"
Task: "Integration test landed cost re-balance in tests/integration/us1-landed-cost.test.ts"
Task: "Integration test referential guards in tests/integration/us1-referential-guard.test.ts"
Task: "Integration test stock counts in tests/integration/us1-stock-count.test.ts"

# Then the independent catalogue actions:
Task: "Product actions in app/(app)/inventory/actions.ts"
Task: "Vendor actions in app/(app)/vendors/actions.ts"
Task: "Quality grade actions in app/(app)/grades/actions.ts"
```

---

## Implementation Strategy

### MVP scope

**Phases 1 + 2 + 3 (T001–T053).** That delivers a catalogue and correctly costed, correctly funded
batches — the foundation every other figure reads from. It is demoable: two vendors, two grades, two
batches of the same product, correct per-unit costs that sum exactly to the batch totals.

Be aware the MVP alone does not let anyone sell. If the goal is a usable till rather than a provably
correct foundation, **Phases 1 + 2 + 3 + 4 (through T070a)** is the smallest genuinely useful release.

### Incremental delivery

1. Setup + Foundational → migrations apply, invariants assert clean
2. + US1 → stock exists with true cost attribution → demo
3. + US2 → the shop can trade; oversell proven impossible → deploy
4. + US3 → capital and cash are complete; Invariant B closes
5. + US4 → the owner's headline question is answered
6. + US5 → vendor and grade margins drive buying decisions

### Parallel team strategy

After Phase 2: Developer A on US1 (receiving, the critical dependency), Developer B on US3 capital
services (independent of US1's UI), Developer C on the US2 till shell and concurrency harness —
T056/T057 can be built against a stub decrement before `recordSale` exists.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task
- Every mutation takes `idempotencyKey` as its **first** argument, generated once at first form render
- Every write ends with `updateTag`, never `revalidateTag`
- Commit after each task or logical group; stop at any checkpoint to validate a story independently
- The constraints in `CLAUDE.md` are correctness requirements, not style preferences — see
  [research.md](./research.md) for the evidence behind each
