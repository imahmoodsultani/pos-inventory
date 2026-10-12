import "server-only";

/**
 * The edit audit log (FR-045a, FR-045b, data-model §15).
 *
 * Where a record is immutable, "how did this figure come to be?" is answered by the fact that it
 * never changed. Capital events are now correctable in place, so that question needs answering
 * some other way, and this is it.
 *
 * Two properties make it worth trusting:
 *
 *   - It is written in the SAME TRANSACTION as the edit, so a change cannot be saved without its
 *     audit trail. A best-effort log written afterwards is absent exactly when something went wrong.
 *   - The table is append-only by trigger. An audit trail that can be rewritten answers nothing.
 */

import { and, desc, eq } from "drizzle-orm";

import type { Database, Tx } from "@/lib/db";
import { recordEdits } from "@/lib/db/schema";

/**
 * Field names whose values must never be stored.
 *
 * A DENY-LIST rather than an allow-list, deliberately. New non-secret fields appear constantly and
 * new secret fields rarely, so the failure mode of forgetting to update this is "a new field gets
 * audited" rather than "a new secret leaks". Matched as a substring, case-insensitively, so
 * `passwordHash` and `resetToken` are both caught.
 */
const SECRET_FIELD_PATTERNS = ["password", "token", "secret", "credential"];

export function isSecretField(fieldName: string): boolean {
  const lowered = fieldName.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((p) => lowered.includes(p));
}

export type FieldChange = {
  field: string;
  /** Anything stringifiable. Dates are stored ISO; null and undefined become null. */
  from: unknown;
  to: unknown;
};

function serialise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Compare two shallow objects and return only the fields that actually differ.
 *
 * Used so an "edit" that changed nothing writes no audit rows — an audit log full of no-op entries
 * is one nobody reads.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, to] of Object.entries(after)) {
    if (to === undefined) continue; // not supplied by the caller — not a change
    const from = before[field];
    if (serialise(from) === serialise(to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

export type RecordEditsParams = {
  tableName: string;
  /** TEXT because users.id is a Better Auth text id while everything else is bigint. */
  recordId: string | number;
  changes: FieldChange[];
  reason?: string;
  /** Supplied when several records change as one action, so they share a group. */
  editGroup?: string;
};

/**
 * Write one audit row per changed field, all sharing an `editGroup`.
 *
 * Returns the group id so a caller spanning several records can thread it through.
 */
export async function recordEditsFor(
  tx: Tx,
  actor: string,
  params: RecordEditsParams,
): Promise<string> {
  const editGroup = params.editGroup ?? crypto.randomUUID();
  if (params.changes.length === 0) return editGroup;

  await tx.insert(recordEdits).values(
    params.changes.map((change) => {
      const secret = isSecretField(change.field);
      return {
        tableName: params.tableName,
        recordId: String(params.recordId),
        fieldName: change.field,
        // A secret records THAT it changed, never either value.
        oldValue: secret ? null : serialise(change.from),
        newValue: secret ? null : serialise(change.to),
        reason: params.reason ?? null,
        editGroup,
        changedBy: actor,
      };
    }),
  );

  return editGroup;
}

export type EditHistoryRow = {
  id: number;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  editGroup: string;
  changedBy: string;
  changedAt: Date;
};

/** Edit history for one record, newest first (FR-045a). */
export async function getEditHistory(
  dbx: Database | Tx,
  tableName: string,
  recordId: string | number,
  limit = 50,
): Promise<EditHistoryRow[]> {
  return dbx
    .select({
      id: recordEdits.id,
      fieldName: recordEdits.fieldName,
      oldValue: recordEdits.oldValue,
      newValue: recordEdits.newValue,
      reason: recordEdits.reason,
      editGroup: recordEdits.editGroup,
      changedBy: recordEdits.changedBy,
      changedAt: recordEdits.changedAt,
    })
    .from(recordEdits)
    .where(
      and(
        eq(recordEdits.tableName, tableName),
        eq(recordEdits.recordId, String(recordId)),
      ),
    )
    .orderBy(desc(recordEdits.changedAt), desc(recordEdits.id))
    .limit(limit);
}
