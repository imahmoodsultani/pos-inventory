/**
 * Nightly reconciliation (T095).
 *
 * Runs Invariants A, B, and C against production and shouts if any of them fails. This is the
 * last line of defence: every write path is tested, but a bug that only manifests under a
 * combination nobody foresaw shows up here first — and the alternative is the owner noticing
 * their numbers are wrong weeks later, with no idea when it started.
 *
 * A Route Handler invoked by Vercel Cron, NOT an in-process timer (Constitution Principle III):
 * serverless instances are frozen between requests, so a setInterval would simply never fire.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { checkAllInvariants } from "@/lib/dal/invariants";
import { logInternalError, logWarning } from "@/lib/logging";

// No `export const dynamic` — Next.js 16 rejects it when cacheComponents is enabled, and it is
// unnecessary: reading the Authorization header already makes this handler dynamic.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  // The secret check comes FIRST, before any database work. This endpoint is publicly
  // reachable, and an unauthenticated caller must not be able to make it do anything at all.
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    return await db.transaction(async (tx) => {
      /**
       * Transaction-scoped advisory lock so two overlapping invocations do not both run the
       * full sweep. `pg_advisory_xact_lock` — never the session-scoped variant, which leaks
       * permanently under PgBouncer because the unlock may land on a different backend.
       *
       * `try_` so a second invocation returns immediately instead of queueing behind the first
       * and timing out.
       */
      const lock = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext('cron_reconcile')) AS acquired`,
      );
      const acquired = (
        Array.isArray(lock) ? lock : ((lock as unknown as { rows: unknown[] }).rows ?? [])
      )[0] as { acquired?: boolean } | undefined;

      if (!acquired?.acquired) {
        return Response.json({ skipped: "another reconcile is already running" });
      }

      const results = await checkAllInvariants(tx);
      const broken = results.filter((r) => !r.holds);

      if (broken.length > 0) {
        // Logged at ERROR so it surfaces in alerting. The 500 is deliberate: a cron job that
        // reports success while the books are wrong is worse than no cron job.
        for (const r of broken) {
          logWarning("cron.reconcile", `INVARIANT BROKEN — ${r.name}: ${r.detail}`);
        }
        console.error(
          JSON.stringify({
            level: "error",
            action: "cron.reconcile",
            at: new Date().toISOString(),
            message: "Ledger invariants failed",
            broken: broken.map((r) => ({ name: r.name, detail: r.detail })),
          }),
        );
        return Response.json(
          { ok: false, broken: broken.map((r) => ({ name: r.name, detail: r.detail })) },
          { status: 500 },
        );
      }

      return Response.json({
        ok: true,
        checked: results.map((r) => r.name),
        at: new Date().toISOString(),
      });
    });
  } catch (error) {
    const correlationId = logInternalError("cron.reconcile", error);
    return Response.json({ ok: false, correlationId }, { status: 500 });
  }
}
