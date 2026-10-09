<!--
Sync Impact Report
==================
Version change: TEMPLATE (unversioned) → 1.0.0
Bump rationale: Initial ratification — all placeholder tokens replaced with concrete
                governance for a web-based POS + inventory application targeting Vercel.

Modified principles:
  [PRINCIPLE_1_NAME] → I. Transactional Integrity (NON-NEGOTIABLE)
  [PRINCIPLE_2_NAME] → II. Inventory Is a Ledger
  [PRINCIPLE_3_NAME] → III. Stateless & Deployment-Portable
  [PRINCIPLE_4_NAME] → IV. Authenticated and Auditable by Default
  [PRINCIPLE_5_NAME] → V. Minimum Viable Scope (YAGNI)

Added sections:
  [SECTION_2_NAME] → Technology & Deployment Constraints
  [SECTION_3_NAME] → Development Workflow & Quality Gates

Removed sections: none

Templates requiring updates:
  ✅ .specify/templates/plan-template.md     — "Constitution Check" gate is generic
                                                ("[Gates determined based on constitution file]");
                                                no edit required, gates derive from this file.
  ✅ .specify/templates/spec-template.md      — no constitution-mandated sections added/removed.
  ✅ .specify/templates/tasks-template.md     — existing Setup/Foundational/Polish phases already
                                                cover auth, migrations, logging, and env config.
  ⚠ README.md / docs/quickstart.md           — do not exist yet; create when the codebase is
                                                scaffolded and link this constitution.

Follow-up TODOs: none. No placeholders deferred.
-->

# POS Inventory Constitution

## Core Principles

### I. Transactional Integrity (NON-NEGOTIABLE)

A sale, return, or stock adjustment MUST commit as a single atomic database transaction covering
both the financial record and the resulting stock movement; partial writes are a defect, not an
edge case. Every mutating operation MUST accept a client-supplied idempotency key and MUST return
the original result when replayed with that key. Monetary amounts MUST be stored as integer minor
units (e.g. cents) — floating-point money is forbidden. A sale MUST be rejected, not silently
adjusted, when it would drive tracked stock below zero unless the product is explicitly flagged as
backorderable.

**Rationale**: A POS handles money and physical goods. Serverless functions retry, networks drop
mid-request, and cashiers double-tap. Without atomicity and idempotency the system invents or
destroys revenue and inventory, and no amount of later reporting can reconstruct the truth.

### II. Inventory Is a Ledger

On-hand quantity MUST be derived from an append-only sequence of stock movements (receipt, sale,
return, adjustment, transfer), each recording product, quantity delta, reason, actor, and
timestamp. Movement rows MUST NOT be updated or deleted; corrections are new compensating
movements. A cached or denormalized quantity column is permitted only as a performance optimization
that MUST be reconstructible from the ledger, and a reconciliation path MUST exist to prove it.

**Rationale**: "Why does the count say 7 when the shelf has 5?" is the single most common inventory
question. A mutable quantity field cannot answer it; a ledger always can.

### III. Stateless & Deployment-Portable

Application code MUST NOT rely on in-process memory, local filesystem writes, background threads,
or long-lived connections surviving between requests. All state MUST live in the managed database
or object storage. All configuration and secrets MUST be read from environment variables with no
secret values committed to the repository. Scheduled work MUST be expressed as an HTTP endpoint
invoked by a scheduler, not an in-process timer.

**Rationale**: The target runtime is Vercel's serverless/edge model, where instances are ephemeral
and horizontally scaled. Code that assumes a single long-lived server passes locally and fails in
production. Honouring this also keeps the project portable off Vercel if that choice changes.

### IV. Authenticated and Auditable by Default

Every route except the login flow and explicitly declared public assets MUST require an
authenticated session, enforced server-side — client-side hiding of UI is not access control. Each
user MUST carry at least one role, and permission checks MUST happen in the server handler that
performs the mutation. Every operation that moves money or stock MUST persist the acting user id
and a server-generated timestamp. Price overrides, discounts, voids, and manual stock adjustments
MUST record a reason.

**Rationale**: Retail shrinkage is predominantly internal. An unattributed adjustment is
indistinguishable from theft, and a POS that cannot name who voided a sale cannot be trusted with
a till.

### V. Minimum Viable Scope (YAGNI)

The first release MUST be limited to: product catalogue, stock levels and movements, a checkout
flow producing a sale record, and basic user authentication with roles. Multi-location, loyalty
programs, promotions engines, purchase orders, accounting integrations, and offline mode are
explicitly out of scope until the core is in production use. New dependencies, services, caches, or
abstraction layers MUST be justified against a concrete current requirement in the feature plan;
"we will need it later" is not a justification.

**Rationale**: POS projects fail by accreting features before the sale-to-stock path is correct.
Scope discipline keeps the transactional core — the part that is genuinely hard — reviewable.

## Technology & Deployment Constraints

- The application MUST be a single TypeScript web application deployable to Vercel from the
  repository root with no custom build server.
- Persistence MUST be a managed, connection-pooled, Vercel-reachable relational database (Postgres).
  Schema changes MUST be applied through versioned, checked-in migration files; ad-hoc schema edits
  against any shared environment are forbidden.
- Database access from serverless functions MUST use a pooled or HTTP-based driver; raw unpooled
  per-request connections are forbidden.
- Secrets MUST be configured per environment (development, preview, production) in the hosting
  platform's environment variable store. `.env` files containing real credentials MUST NOT be
  committed; a `.env.example` listing required keys MUST be maintained.
- Preview and production environments MUST NOT share a database.
- The checkout screen MUST remain usable on a touch screen at 1024px width or narrower, and the
  primary "add item → tender → complete sale" path MUST respond within 1 second at p95 under
  expected single-store load.
- Unhandled server errors MUST be logged with a correlation id and MUST NOT leak stack traces,
  SQL, or secret values to the client.

## Development Workflow & Quality Gates

- Work MUST follow the spec → plan → tasks → implement flow; a feature branch MUST trace to a spec
  under `specs/`.
- Every change MUST pass type-checking and linting before merge. A change touching the sale, stock
  movement, or pricing logic MUST include automated tests covering at least the success path, the
  insufficient-stock path, and the idempotent-replay path.
- Every pull request MUST be verified against a Vercel preview deployment, not only a local dev
  server.
- Migrations MUST be forward-only and MUST be applied to preview before production.
- Pull request review MUST confirm compliance with these principles. A justified deviation MUST be
  recorded in the plan's Complexity Tracking table, naming the simpler alternative rejected and
  why.
- `main` MUST remain deployable at all times.

## Governance

This constitution supersedes other practices and conventions for this project. Where a tool
default, a template, or a habit conflicts with a principle here, the principle wins.

Amendments MUST be made by editing this file in a pull request that states the rationale and the
migration impact on existing code or data. Versioning follows semantic versioning: MAJOR for
removing or redefining a principle in a backward-incompatible way, MINOR for adding a principle or
materially expanding guidance, PATCH for clarifications and wording that do not change obligations.
The amending pull request MUST update the version line and the Sync Impact Report at the top of
this file, and MUST update any dependent template under `.specify/templates/` that the amendment
affects.

Compliance is reviewed at every pull request. Any principle labelled NON-NEGOTIABLE MUST NOT be
waived via Complexity Tracking; it can only be changed by amending this constitution.

**Version**: 1.0.0 | **Ratified**: 2026-10-09 | **Last Amended**: 2026-10-09
