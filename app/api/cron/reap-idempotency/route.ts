/**
 * Expired idempotency key reaper (T096).
 *
 * Keys are claimed on every mutation and kept for 72 hours so a late retry can replay its
 * stored response. Past that they are dead weight, and the table is on the write path of every
 * sale — an unbounded one would slowly make checkout slower.
 *
 * Deletes in BATCHES rather than one statement: a single unbounded DELETE takes locks
 * proportional to the backlog, and the first run after an outage is exactly when the backlog is
 * largest and the till is busiest.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { logInternalError } from "@/lib/logging";

// No `export const dynamic` — Next.js 16 rejects it when cacheComponents is enabled, and it is
// unnecessary: reading the Authorization header already makes this handler dynamic.
export const maxDuration = 60;

const BATCH_SIZE = 1_000;
const MAX_BATCHES = 50;

export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const removed = await db.transaction(async (tx) => {
        const lock = await tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('cron_reap_idempotency')) AS acquired`,
        );
        const acquired = (
          Array.isArray(lock) ? lock : ((lock as unknown as { rows: unknown[] }).rows ?? [])
        )[0] as { acquired?: boolean } | undefined;
        if (!acquired?.acquired) return -1;

        const result = await tx.execute(sql`
          DELETE FROM idempotency_keys
           WHERE id IN (
             SELECT id FROM idempotency_keys
              WHERE expires_at < now()
              ORDER BY id
              LIMIT ${BATCH_SIZE}
              FOR UPDATE SKIP LOCKED
           )
        `);
        return (result as unknown as { rowCount?: number }).rowCount ?? 0;
      });

      if (removed === -1) {
        return Response.json({ skipped: "another reap is already running", deleted });
      }
      deleted += removed;
      if (removed < BATCH_SIZE) break;
    }

    return Response.json({ ok: true, deleted, at: new Date().toISOString() });
  } catch (error) {
    const correlationId = logInternalError("cron.reapIdempotency", error);
    return Response.json({ ok: false, correlationId }, { status: 500 });
  }
}
