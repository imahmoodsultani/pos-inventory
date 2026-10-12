"use server";

/** Product catalogue Server Actions (T042). Owner only. */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import {
  createProduct,
  deactivateProduct,
  deleteProduct,
  updateProduct,
} from "@/lib/services/catalogue";

/**
 * FR-001 — discrete countable units ONLY. Weight and length are rejected here and again by a
 * database CHECK, because every quantity column is INTEGER: a fractional unit could be stored
 * but never transacted.
 */
const unitOfMeasure = z.enum(["piece", "box", "pack", "pair"], {
  error: "Choose a countable unit: piece, box, pack, or pair.",
});

export const createProductAction = defineAction({
  name: "createProduct",
  role: "owner",
  schema: z.object({
    code: z.string().trim().min(1, { error: "A product code is required." }).max(60),
    name: z.string().trim().min(1, { error: "A name is required." }).max(160),
    unitOfMeasure,
    reorderLevel: z.number().int().nonnegative().default(0),
  }),
  tags: () => [tags.catalogue, tags.stock],
  handler: ({ tx, user, input }) => createProduct(tx, user.id, input),
});

export const updateProductAction = defineAction({
  name: "updateProduct",
  role: "owner",
  schema: z.object({
    productId: z.number().int().positive(),
    name: z.string().trim().min(1).max(160).optional(),
    reorderLevel: z.number().int().nonnegative().optional(),
  }),
  tags: (input) => [tags.catalogue, tags.stockForProduct(input.productId)],
  handler: ({ tx, user, input }) => updateProduct(tx, user.id, input),
});

export const deactivateProductAction = defineAction({
  name: "deactivateProduct",
  role: "owner",
  schema: z.object({ productId: z.number().int().positive() }),
  tags: () => [tags.catalogue, tags.stock],
  handler: ({ tx, user, input }) => deactivateProduct(tx, user.id, input),
});

/**
 * Always fails with CONFLICT, by design (FR-004). It exists so the UI's delete affordance has
 * somewhere to go that explains WHY deletion is impossible and names what references the row —
 * rather than the button simply not existing, which teaches the owner nothing.
 */
export const deleteProductAction = defineAction({
  name: "deleteProduct",
  role: "owner",
  schema: z.object({ productId: z.number().int().positive() }),
  handler: ({ tx, user, input }) => deleteProduct(tx, user.id, input),
});
