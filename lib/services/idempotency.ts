/**
 * Idempotency (T031, Constitution Principle I, D9).
 *
 * The till is a tab left open all day on a flaky connection. A cashier who taps "Complete sale"
 * twice, or whose request is retried by the network, must not create two sales — and must not be
 * told their sale failed when it actually succeeded.
 *
 * The mechanism is the UNIQUE INDEX on (scope, key). Claiming is
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, which is atomic: exactly one concurrent
 * caller gets a row back, everyone else gets nothing. No SELECT-then-INSERT, which has a race
 * between the two statements wide enough to drive a duplicate sale through.
 *
 * THE CLAIM MUST HAPPEN INSIDE THE BUSINESS TRANSACTION. This function therefore takes a
 * transaction handle rather than the pool. If the claim committed separately, a crash between
 * claim and business write would burn the key: the retry would be told "already done" and the
 * sale would be lost forever.
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { idempotencyKeys } from "@/lib/db/schema";

export type ClaimOutcome =
  /** This caller owns the work. Proceed with the business write. */
  | { status: "claimed"; id: number }
  /** Same key, same payload, already finished. Replay the stored response verbatim. */
  | { status: "replay"; responseBody: unknown }
  /** Same key, DIFFERENT payload. The client reused a key for different data — never guess. */
  | { status: "conflict" }
  /** Same key, still running elsewhere. The client should retry shortly. */
  | { status: "in_flight" };

/**
 * Stable hash of the request payload.
 *
 * Keys are sorted recursively so that `{a:1,b:2}` and `{b:2,a:1}` hash identically — otherwise a
 * retry whose JSON happened to serialise in a different key order would look like a different
 * request and be rejected as a conflict.
 */
export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(canonicalise(payload)).digest("hex");
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

export async function claimIdempotencyKey(
  tx: Tx,
  params: {
    scope: string;
    key: string;
    actionName: string;
    requestHash: string;
    /** How long a completed result stays replayable. */
    ttlHours?: number;
  },
): Promise<ClaimOutcome> {
  const { scope, key, actionName, requestHash, ttlHours = 72 } = params;

  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      scope,
      key,
      actionName,
      requestHash,
      status: "in_progress",
      expiresAt: sql`now() + make_interval(hours => ${ttlHours})`,
    })
    .onConflictDoNothing({ target: [idempotencyKeys.scope, idempotencyKeys.key] })
    .returning({ id: idempotencyKeys.id });

  if (inserted.length > 0) {
    return { status: "claimed", id: inserted[0].id };
  }

  // Lost the race, or this is a genuine retry. Read the existing row to find out which.
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
    .limit(1);

  if (!existing) {
    // The row vanished between the failed insert and this read — only possible if the reaper
    // deleted an expired key in the gap. Treating it as in-flight asks the client to retry,
    // which will then claim cleanly.
    return { status: "in_flight" };
  }

  // Check the payload BEFORE the status: a reused key carrying different data is a client bug,
  // and replaying an unrelated stored response would be far worse than refusing.
  if (existing.requestHash !== requestHash) {
    return { status: "conflict" };
  }

  if (existing.status === "in_progress") {
    return { status: "in_flight" };
  }

  return { status: "replay", responseBody: existing.responseBody };
}

/** Record the outcome so a later duplicate can be replayed. Same transaction as the write. */
export async function completeIdempotencyKey(
  tx: Tx,
  id: number,
  responseBody: unknown,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ status: "succeeded", responseBody: responseBody as never })
    .where(eq(idempotencyKeys.id, id));
}

/**
 * Mark a claim failed.
 *
 * MUST run on its own connection, not the rolled-back transaction: if the business write failed,
 * the transaction is aborted and this update would be discarded with it, leaving the key stuck
 * in_progress until it expires.
 */
export async function failIdempotencyKey(
  executor: { update: Tx["update"] },
  id: number,
): Promise<void> {
  await executor
    .update(idempotencyKeys)
    .set({ status: "failed" })
    .where(eq(idempotencyKeys.id, id));
}
