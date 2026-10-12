import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { recordEdits } from "@/lib/db/schema";
import {
  diffFields,
  getEditHistory,
  isSecretField,
  recordEditsFor,
} from "@/lib/services/audit";

import { ACTOR } from "./fixtures";
import { startTestDatabase, stopTestDatabase, truncateAll, type TestDb } from "./setup";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await stopTestDatabase();
});
beforeEach(async () => {
  await truncateAll();
});

describe("edit audit log (FR-045a, FR-045b)", () => {
  it("writes one row per changed field, sharing an edit group", async () => {
    const group = await db.transaction((tx) =>
      recordEditsFor(tx as Tx, ACTOR, {
        tableName: "vendors",
        recordId: 12,
        changes: [
          { field: "name", from: "Nortside", to: "Northside" },
          { field: "phone", from: "0300-000", to: "0300-111" },
        ],
      }),
    );

    const rows = await db.select().from(recordEdits);
    expect(rows).toHaveLength(2);

    // One action, not two unrelated events.
    expect(new Set(rows.map((r) => r.editGroup))).toEqual(new Set([group]));
    expect(rows.every((r) => r.tableName === "vendors" && r.recordId === "12")).toBe(true);
    expect(rows.every((r) => r.changedBy === ACTOR)).toBe(true);

    const name = rows.find((r) => r.fieldName === "name")!;
    expect(name.oldValue).toBe("Nortside");
    expect(name.newValue).toBe("Northside");
  });

  it("writes nothing when an edit is rejected", async () => {
    await expect(
      db.transaction(async (tx) => {
        await recordEditsFor(tx as Tx, ACTOR, {
          tableName: "vendors",
          recordId: 1,
          changes: [{ field: "name", from: "a", to: "b" }],
        });
        // The business write fails after the audit row is staged.
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");

    // Same transaction, so the audit row rolled back with it. A log that survives a failed edit
    // records changes that never happened.
    expect(await db.select().from(recordEdits)).toHaveLength(0);
  });

  it("writes nothing when no field actually changed", async () => {
    await db.transaction((tx) =>
      recordEditsFor(tx as Tx, ACTOR, {
        tableName: "vendors",
        recordId: 1,
        changes: diffFields({ name: "Acme", phone: "123" }, { name: "Acme", phone: "123" }),
      }),
    );
    expect(await db.select().from(recordEdits)).toHaveLength(0);
  });

  it("is append-only at the database, not by convention", async () => {
    await db.transaction((tx) =>
      recordEditsFor(tx as Tx, ACTOR, {
        tableName: "vendors",
        recordId: 1,
        changes: [{ field: "name", from: "a", to: "b" }],
      }),
    );
    const [row] = await db.select().from(recordEdits);

    await expect(
      db.update(recordEdits).set({ newValue: "tampered" }).where(eq(recordEdits.id, row.id)),
    ).rejects.toThrow();

    await expect(
      db.delete(recordEdits).where(eq(recordEdits.id, row.id)),
    ).rejects.toThrow();

    // Still exactly as written.
    const [after] = await db.select().from(recordEdits);
    expect(after.newValue).toBe("b");
  });

  it("never stores a secret value", async () => {
    await db.transaction((tx) =>
      recordEditsFor(tx as Tx, ACTOR, {
        tableName: "users",
        recordId: "user-1",
        changes: [
          { field: "password", from: "old-secret-value", to: "new-secret-value" },
          { field: "passwordHash", from: "$2a$old", to: "$2a$new" },
          { field: "resetToken", from: "tok-old", to: "tok-new" },
          { field: "name", from: "Sam", to: "Samantha" },
        ],
      }),
    );

    const rows = await db.select().from(recordEdits);
    const serialised = JSON.stringify(rows);

    // The fact of the change is recorded...
    expect(rows.map((r) => r.fieldName).sort()).toEqual(
      ["name", "password", "passwordHash", "resetToken"].sort(),
    );
    // ...but no secret value appears anywhere in the table.
    for (const secret of ["old-secret-value", "new-secret-value", "$2a$old", "$2a$new", "tok-old", "tok-new"]) {
      expect(serialised, `secret "${secret}" leaked into the audit log`).not.toContain(secret);
    }
    // A non-secret field in the same edit keeps its values.
    expect(rows.find((r) => r.fieldName === "name")?.newValue).toBe("Samantha");
  });

  it("recognises secret fields by substring, case-insensitively", () => {
    // Proves the detector detects — a guard that cannot fire protects nothing.
    for (const f of ["password", "Password", "passwordHash", "apiToken", "SECRET_KEY", "credential"]) {
      expect(isSecretField(f), `${f} should be treated as secret`).toBe(true);
    }
    for (const f of ["name", "email", "amountMinor", "note"]) {
      expect(isSecretField(f), `${f} should not be treated as secret`).toBe(false);
    }
  });

  it("returns history newest first", async () => {
    for (const [from, to] of [["a", "b"], ["b", "c"], ["c", "d"]]) {
      await db.transaction((tx) =>
        recordEditsFor(tx as Tx, ACTOR, {
          tableName: "vendors",
          recordId: 7,
          reason: `step ${to}`,
          changes: [{ field: "name", from, to }],
        }),
      );
    }

    const history = await getEditHistory(db, "vendors", 7);
    expect(history).toHaveLength(3);
    expect(history[0].newValue).toBe("d");
    expect(history[0].reason).toBe("step d");
    expect(history[2].newValue).toBe("b");
  });

  it("serialises dates and nulls without losing them", async () => {
    await db.transaction((tx) =>
      recordEditsFor(tx as Tx, ACTOR, {
        tableName: "capital_events",
        recordId: 3,
        changes: [
          { field: "occurredAt", from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") },
          { field: "note", from: null, to: "Corrected" },
        ],
      }),
    );

    const rows = await db.select().from(recordEdits);
    const date = rows.find((r) => r.fieldName === "occurredAt")!;
    expect(date.oldValue).toBe("2026-01-01T00:00:00.000Z");

    const note = rows.find((r) => r.fieldName === "note")!;
    expect(note.oldValue).toBeNull();
    expect(note.newValue).toBe("Corrected");
  });
});
