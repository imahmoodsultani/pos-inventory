import "server-only";

/**
 * Products, vendors, and quality grades (FR-001 … FR-004).
 *
 * FR-004 is the interesting rule: a catalogue entry that is REFERENCED can never be deleted,
 * because deleting it would orphan the cost attribution on every batch and sale line that points
 * at it — the exact history this system exists to preserve. Deactivation is offered instead, and
 * inactive entries stay visible in all history and reports while disappearing from new receipts.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { batches, products, qualityGrades, saleLines, vendors } from "@/lib/db/schema";
import { diffFields, recordEditsFor } from "@/lib/services/audit";
import { DomainError } from "@/lib/services/domain-error";

type Actor = string;

export type UnitOfMeasure = "piece" | "box" | "pack" | "pair";

export async function createProduct(
  tx: Tx,
  actor: Actor,
  input: {
    code: string;
    name: string;
    unitOfMeasure: UnitOfMeasure;
    reorderLevel?: number;
  },
): Promise<{ productId: number }> {
  await assertCodeAvailable(tx, "products", input.code);
  const [row] = await tx
    .insert(products)
    .values({
      code: input.code.trim(),
      name: input.name.trim(),
      unitOfMeasure: input.unitOfMeasure,
      reorderLevel: input.reorderLevel ?? 0,
      createdBy: actor,
    })
    .returning({ id: products.id });
  return { productId: row.id };
}

export async function updateProduct(
  tx: Tx,
  actor: Actor,
  input: { productId: number; name?: string; reorderLevel?: number },
): Promise<{ productId: number }> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.reorderLevel !== undefined) patch.reorderLevel = input.reorderLevel;

  if (Object.keys(patch).length === 0) {
    throw new DomainError("VALIDATION", "Nothing to update.");
  }

  // unit_of_measure is deliberately NOT updatable. Changing it after units exist would silently
  // reinterpret every quantity already recorded against this product.
  const [existing] = await tx
    .select()
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "That product does not exist.");

  const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
  if (changes.length === 0) return { productId: input.productId };

  await tx.update(products).set(patch).where(eq(products.id, input.productId));
  await recordEditsFor(tx, actor, {
    tableName: "products",
    recordId: input.productId,
    changes,
  });

  return { productId: input.productId };
}

export async function deactivateProduct(
  tx: Tx,
  _actor: Actor,
  input: { productId: number },
): Promise<{ productId: number }> {
  const updated = await tx
    .update(products)
    .set({ isActive: false })
    .where(eq(products.id, input.productId))
    .returning({ id: products.id });
  if (updated.length === 0) throw new DomainError("NOT_FOUND", "That product does not exist.");
  return { productId: updated[0].id };
}

/**
 * FR-004. Refuses with CONFLICT and NAMES what references the row, so the owner knows why and
 * what to do instead — "Vendor is used by 3 batches" rather than a foreign-key error.
 */
export async function deleteProduct(
  tx: Tx,
  _actor: Actor,
  input: { productId: number },
): Promise<never> {
  const [{ batchCount, lineCount }] = rows<{ batchCount: number; lineCount: number }>(
    await tx.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM batches WHERE product_id = ${input.productId})    AS "batchCount",
        (SELECT COUNT(*) FROM sale_lines WHERE product_id = ${input.productId}) AS "lineCount"
    `),
  );

  throw new DomainError(
    "CONFLICT",
    referencedMessage("product", [
      [Number(batchCount), "batch"],
      [Number(lineCount), "sale line"],
    ]),
  );
}

export async function createVendor(
  tx: Tx,
  actor: Actor,
  input: { name: string; phone?: string; email?: string; notes?: string },
): Promise<{ vendorId: number }> {
  // Case-insensitive uniqueness is a database expression index; check first for a good message.
  const clash = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(sql`lower(${vendors.name}) = lower(${input.name.trim()})`)
    .limit(1);
  if (clash.length > 0) {
    throw new DomainError("CONFLICT", `A vendor named "${input.name.trim()}" already exists.`, {
      name: ["Already in use"],
    });
  }

  const [row] = await tx
    .insert(vendors)
    .values({
      name: input.name.trim(),
      phone: input.phone,
      email: input.email,
      notes: input.notes,
      createdBy: actor,
    })
    .returning({ id: vendors.id });
  return { vendorId: row.id };
}

/**
 * Correct a vendor's details after creation (FR-045).
 *
 * The vendor keeps its identity, so every batch, frozen sale-line attribution and margin row
 * continues to point at the same vendor. That is the whole reason this exists rather than
 * "deactivate and recreate" — recreating splits one supplier's history into two.
 */
export async function updateVendor(
  tx: Tx,
  actor: Actor,
  input: {
    vendorId: number;
    name?: string;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
  },
): Promise<{ vendorId: number }> {
  const [existing] = await tx
    .select()
    .from(vendors)
    .where(eq(vendors.id, input.vendorId))
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "That vendor does not exist.");

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed === "") {
      throw new DomainError("VALIDATION", "A vendor name is required.", {
        name: ["Required"],
      });
    }
    // Unique case-insensitively, excluding this vendor — renaming to your own name is a no-op,
    // not a conflict.
    const clash = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          sql`lower(${vendors.name}) = lower(${trimmed})`,
          sql`${vendors.id} <> ${input.vendorId}`,
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw new DomainError("CONFLICT", `A vendor named "${trimmed}" already exists.`, {
        name: ["Already in use"],
      });
    }
  }

  const patch = {
    name: input.name?.trim(),
    phone: input.phone,
    email: input.email,
    notes: input.notes,
  };

  const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
  if (changes.length === 0) return { vendorId: input.vendorId };

  await tx.update(vendors).set(patch).where(eq(vendors.id, input.vendorId));
  await recordEditsFor(tx, actor, {
    tableName: "vendors",
    recordId: input.vendorId,
    changes,
  });

  return { vendorId: input.vendorId };
}

/**
 * Correct a quality grade's label and sort order (FR-045).
 *
 * `code` is deliberately absent from the input. It is the short identifier shown against historical
 * sale lines, and changing it would silently relabel what past sales were graded as.
 */
export async function updateQualityGrade(
  tx: Tx,
  actor: Actor,
  input: { gradeId: number; label?: string; sortOrder?: number },
): Promise<{ gradeId: number }> {
  const [existing] = await tx
    .select()
    .from(qualityGrades)
    .where(eq(qualityGrades.id, input.gradeId))
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "That quality grade does not exist.");

  if (input.label !== undefined && input.label.trim() === "") {
    throw new DomainError("VALIDATION", "A label is required.", { label: ["Required"] });
  }

  const patch = { label: input.label?.trim(), sortOrder: input.sortOrder };
  const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
  if (changes.length === 0) return { gradeId: input.gradeId };

  await tx.update(qualityGrades).set(patch).where(eq(qualityGrades.id, input.gradeId));
  await recordEditsFor(tx, actor, {
    tableName: "quality_grades",
    recordId: input.gradeId,
    changes,
  });

  return { gradeId: input.gradeId };
}

export async function deactivateVendor(
  tx: Tx,
  _actor: Actor,
  input: { vendorId: number },
): Promise<{ vendorId: number }> {
  const updated = await tx
    .update(vendors)
    .set({ isActive: false })
    .where(eq(vendors.id, input.vendorId))
    .returning({ id: vendors.id });
  if (updated.length === 0) throw new DomainError("NOT_FOUND", "That vendor does not exist.");
  return { vendorId: updated[0].id };
}

export async function deleteVendor(
  tx: Tx,
  _actor: Actor,
  input: { vendorId: number },
): Promise<never> {
  const [{ batchCount }] = rows<{ batchCount: number }>(
    await tx.execute(sql`
      SELECT (SELECT COUNT(*) FROM batches WHERE vendor_id = ${input.vendorId}) AS "batchCount"
    `),
  );
  throw new DomainError(
    "CONFLICT",
    referencedMessage("vendor", [[Number(batchCount), "batch"]]),
  );
}

export async function createQualityGrade(
  tx: Tx,
  actor: Actor,
  input: { code: string; label: string; sortOrder: number },
): Promise<{ gradeId: number }> {
  await assertCodeAvailable(tx, "quality_grades", input.code);
  const [row] = await tx
    .insert(qualityGrades)
    .values({
      code: input.code.trim(),
      label: input.label.trim(),
      sortOrder: input.sortOrder,
      createdBy: actor,
    })
    .returning({ id: qualityGrades.id });
  return { gradeId: row.id };
}

export async function deleteQualityGrade(
  tx: Tx,
  _actor: Actor,
  input: { gradeId: number },
): Promise<never> {
  const [{ batchCount }] = rows<{ batchCount: number }>(
    await tx.execute(sql`
      SELECT (SELECT COUNT(*) FROM batches WHERE grade_id = ${input.gradeId}) AS "batchCount"
    `),
  );
  throw new DomainError(
    "CONFLICT",
    referencedMessage("quality grade", [[Number(batchCount), "batch"]]),
  );
}

/** Is this grade or vendor safe to hard-delete? Used by the UI to offer the right action. */
export async function countReferences(
  tx: Tx,
  entity: "product" | "vendor" | "grade",
  id: number,
): Promise<number> {
  if (entity === "product") {
    const r = await tx
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(eq(batches.productId, id));
    const l = await tx
      .select({ n: sql<number>`count(*)` })
      .from(saleLines)
      .where(eq(saleLines.productId, id));
    return Number(r[0].n) + Number(l[0].n);
  }
  const column = entity === "vendor" ? batches.vendorId : batches.gradeId;
  const r = await tx
    .select({ n: sql<number>`count(*)` })
    .from(batches)
    .where(eq(column, id));
  return Number(r[0].n);
}

function referencedMessage(entity: string, counts: Array<[number, string]>): string {
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);

  if (parts.length === 0) {
    return (
      `This ${entity} is not referenced, but catalogue entries are never deleted — ` +
      `deactivate it instead so existing history keeps its meaning.`
    );
  }
  return (
    `This ${entity} is used by ${parts.join(" and ")} and cannot be deleted. ` +
    `Deactivate it instead: it will disappear from new receipts but stay in all history.`
  );
}

async function assertCodeAvailable(
  tx: Tx,
  table: "products" | "quality_grades",
  code: string,
): Promise<void> {
  const target = table === "products" ? products : qualityGrades;
  const clash = await tx
    .select({ id: target.id })
    .from(target)
    .where(and(sql`lower(${target.code}) = lower(${code.trim()})`))
    .limit(1);
  if (clash.length > 0) {
    throw new DomainError("CONFLICT", `The code "${code.trim()}" is already in use.`, {
      code: ["Already in use"],
    });
  }
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
