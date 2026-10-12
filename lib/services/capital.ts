import "server-only";

/**
 * Capital injections and withdrawals (T075, T076, FR-024, FR-025, FR-031).
 *
 * These are the ONLY two things that move capital invested and capital recovered. The funding
 * split on a purchase is descriptive and feeds neither (FR-026a) — treating "this stock was
 * bought with new capital" as a second injection double-counts the money the moment it is spent,
 * and breaks the SC-003 identity on the very first purchase.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { capitalEvents, cashEvents } from "@/lib/db/schema";
import { diffFields, recordEditsFor } from "@/lib/services/audit";
import { DomainError } from "@/lib/services/domain-error";
import { messages } from "@/lib/types/action-result";

type Actor = string;

/**
 * Cash on hand, derived from the ledger and never stored as a mutable total.
 *
 * `FOR UPDATE` is NOT used here and cannot be: there is no single row to lock — the balance is a
 * SUM over an append-only table. The guard below is safe for a different reason, explained there.
 */
export async function getCashOnHandMinor(tx: Tx): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'in'), 0)
         - COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'out'), 0) AS balance
      FROM cash_events
  `);
  const first = (
    Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
  )[0] as { balance?: number | string } | undefined;
  return Number(first?.balance ?? 0);
}

/**
 * The shared cash-floor guard (T076, FR-031). Used by withdrawals AND by receiveStock.
 *
 * ⚠️ CONCURRENCY NOTE. Two simultaneous debits can each read the same balance and both pass this
 * check, overdrawing the till — the classic read-then-write race, and the same shape the guarded
 * conditional UPDATE exists to avoid on stock.
 *
 * It is handled by taking a transaction-scoped ADVISORY LOCK on the cash ledger, so debits
 * serialise against each other. `pg_advisory_xact_lock` specifically: the session-scoped
 * `pg_advisory_lock` would leak permanently under PgBouncer, which multiplexes sessions between
 * transactions and would never run the matching unlock on the same backend.
 *
 * Only DEBITS take the lock. Credits (injections, sale receipts) can never drive the balance
 * negative, so they are free to proceed concurrently.
 */
export async function assertCashAvailable(tx: Tx, amountMinor: number): Promise<number> {
  // A fixed key; the whole cash ledger is one resource. Released automatically at commit.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cash_ledger'))`);

  const balance = await getCashOnHandMinor(tx);
  if (amountMinor > balance) {
    throw new DomainError("INSUFFICIENT_CASH", messages.insufficientCash(balance));
  }
  return balance;
}

export type CapitalResult = {
  eventId: number;
  cashOnHandMinor: number;
  capitalInvestedMinor: number;
  capitalRecoveredMinor: number;
};

/** FR-024 — the owner puts money in. Raises cash AND capital invested by the same amount. */
export async function recordCapitalInjection(
  tx: Tx,
  actor: Actor,
  input: { amountMinor: number; occurredAt: Date; note?: string },
): Promise<CapitalResult> {
  if (input.amountMinor <= 0) {
    throw new DomainError("VALIDATION", "An injection must be more than zero.", {
      amountMinor: ["Must be greater than zero"],
    });
  }

  const [event] = await tx
    .insert(capitalEvents)
    .values({
      eventType: "injection",
      amountMinor: input.amountMinor,
      occurredAt: input.occurredAt,
      note: input.note,
      createdBy: actor,
    })
    .returning({ id: capitalEvents.id });

  await tx.insert(cashEvents).values({
    direction: "in",
    amountMinor: input.amountMinor,
    sourceType: "capital_injection",
    sourceId: event.id,
    occurredAt: input.occurredAt,
    createdBy: actor,
  });

  return summarise(tx, event.id);
}

/**
 * FR-025 — the owner takes money out. Lowers cash and raises capital RECOVERED.
 *
 * Note it raises recovered rather than lowering invested: those are two different facts. "I put
 * in 10,000 and have taken 3,000 back out" is the story the owner needs, and netting it to
 * "invested 7,000" destroys it.
 */
export async function recordWithdrawal(
  tx: Tx,
  actor: Actor,
  input: { amountMinor: number; occurredAt: Date; note?: string },
): Promise<CapitalResult> {
  if (input.amountMinor <= 0) {
    throw new DomainError("VALIDATION", "A withdrawal must be more than zero.", {
      amountMinor: ["Must be greater than zero"],
    });
  }

  await assertCashAvailable(tx, input.amountMinor);

  const [event] = await tx
    .insert(capitalEvents)
    .values({
      eventType: "withdrawal",
      amountMinor: input.amountMinor,
      occurredAt: input.occurredAt,
      note: input.note,
      createdBy: actor,
    })
    .returning({ id: capitalEvents.id });

  await tx.insert(cashEvents).values({
    direction: "out",
    amountMinor: input.amountMinor,
    sourceType: "withdrawal",
    sourceId: event.id,
    occurredAt: input.occurredAt,
    createdBy: actor,
  });

  return summarise(tx, event.id);
}

export type CorrectCapitalEventInput = {
  eventId: number;
  amountMinor: number;
  occurredAt: Date;
  note?: string | null;
  reason: string;
};

/**
 * Correct a capital event in place (FR-046, FR-046a).
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * A CAPITAL EVENT AND ITS CASH EVENT ARE ONE BUSINESS FACT IN TWO ROWS.
 *
 * Capital invested is summed from `capital_events`; cash on hand from `cash_events`. Correcting
 * one without the other breaks the SC-003 identity immediately and silently. Both are therefore
 * updated here, in the caller's transaction, or neither is.
 *
 * `eventType` is absent from the input by design (FR-046a). Flipping an injection into a
 * withdrawal reverses the meaning of the entry entirely; correcting to zero effect and recording
 * the right entry separately is clearer and keeps the mistake visible.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */
export async function correctCapitalEvent(
  tx: Tx,
  actor: Actor,
  input: CorrectCapitalEventInput,
): Promise<CapitalResult> {
  if (!input.reason?.trim()) {
    throw new DomainError("VALIDATION", "Say why this entry is being corrected.", {
      reason: ["Required"],
    });
  }
  if (input.amountMinor <= 0) {
    // A CHECK constraint enforces this too; the friendly message is here.
    throw new DomainError(
      "VALIDATION",
      "A capital entry must be more than zero. To cancel one entirely, correct it to the " +
        "smallest amount and record the reason.",
      { amountMinor: ["Must be greater than zero"] },
    );
  }

  const [existing] = await tx
    .select()
    .from(capitalEvents)
    .where(eq(capitalEvents.id, input.eventId))
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "That capital entry does not exist.");

  /**
   * Serialise against other debits while the balance is read and written (FR-031).
   *
   * `pg_advisory_xact_lock`, never the session-scoped variant — that one leaks permanently under
   * PgBouncer, which multiplexes sessions between transactions.
   */
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cash_ledger'))`);

  const balance = await getCashOnHandMinor(tx);

  /**
   * How this correction moves cash.
   *
   * Both directions can overdraw, which is the non-obvious part: REDUCING a past injection takes
   * money out of the till just as surely as raising a withdrawal does, because the money that
   * arrived may already have been spent on stock.
   */
  const difference = input.amountMinor - existing.amountMinor;
  const cashDelta = existing.eventType === "injection" ? difference : -difference;
  const projected = balance + cashDelta;

  if (projected < 0) {
    const limit = existing.amountMinor + (existing.eventType === "injection" ? -balance : balance);
    throw new DomainError(
      "INSUFFICIENT_CASH",
      `That correction would leave cash on hand at ${projected} (minor units). ` +
        `Cash available is ${balance}. The furthest this entry can move is to ${limit}.`,
      { amountMinor: ["Would overdraw the till"] },
    );
  }

  const patch = {
    amountMinor: input.amountMinor,
    occurredAt: input.occurredAt,
    note: input.note ?? null,
  };
  const changes = diffFields(existing as unknown as Record<string, unknown>, patch);

  if (changes.length === 0) {
    return summarise(tx, input.eventId);
  }

  await tx.update(capitalEvents).set(patch).where(eq(capitalEvents.id, input.eventId));

  // The paired cash row. Its source_type and source_id are immutable by trigger, so only the
  // amount and date move — the row stays attached to this same business event.
  const sourceType = existing.eventType === "injection" ? "capital_injection" : "withdrawal";
  await tx
    .update(cashEvents)
    .set({ amountMinor: input.amountMinor, occurredAt: input.occurredAt })
    .where(
      and(eq(cashEvents.sourceType, sourceType), eq(cashEvents.sourceId, input.eventId)),
    );

  await recordEditsFor(tx, actor, {
    tableName: "capital_events",
    recordId: input.eventId,
    reason: input.reason.trim(),
    changes,
  });

  return summarise(tx, input.eventId);
}

async function summarise(tx: Tx, eventId: number): Promise<CapitalResult> {
  const rows = await tx.execute(sql`
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'injection'), 0)  AS invested,
      COALESCE(SUM(amount_minor) FILTER (WHERE event_type = 'withdrawal'), 0) AS recovered
    FROM capital_events
  `);
  const first = (
    Array.isArray(rows) ? rows : ((rows as unknown as { rows: unknown[] }).rows ?? [])
  )[0] as { invested?: number | string; recovered?: number | string } | undefined;

  return {
    eventId,
    cashOnHandMinor: await getCashOnHandMinor(tx),
    capitalInvestedMinor: Number(first?.invested ?? 0),
    capitalRecoveredMinor: Number(first?.recovered ?? 0),
  };
}

/** Capital event history for the capital screen, newest first. */
export async function listCapitalEvents(tx: Tx, limit = 50) {
  return tx
    .select()
    .from(capitalEvents)
    .orderBy(sql`${capitalEvents.occurredAt} DESC`, sql`${capitalEvents.id} DESC`)
    .limit(limit);
}
