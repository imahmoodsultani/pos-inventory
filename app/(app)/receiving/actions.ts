"use server";

/**
 * Receiving Server Actions (T049).
 *
 * Each is a thin shell: `defineAction` supplies the mandatory preamble — session, role, Zod 4
 * parse, one transaction with the idempotency claim inside it, then `updateTag` after commit —
 * and the service layer supplies the business logic. Nothing here may skip a step, because
 * nothing here performs one.
 */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import {
  addLandedCost,
  correctBatchCost,
  receiveStock,
  returnToVendor,
} from "@/lib/services/receiving";
import { recordStockCount, recordWriteOff } from "@/lib/services/stock-corrections";

/** Money arrives as integer minor units. A float here is a bug, so the schema refuses one. */
const minorUnits = z
  .number()
  .int({ error: "Amounts must be whole minor units — no fractions of a cent." })
  .nonnegative();

const wholeUnits = z
  .number()
  .int({ error: "Quantities must be whole units." })
  .positive({ error: "Quantity must be at least 1." });

const fundingSchema = z.object({
  newCapitalMinor: minorUnits,
  reinvestedMinor: minorUnits,
});

export const receiveStockAction = defineAction({
  name: "receiveStock",
  role: "owner",
  schema: z.object({
    productId: z.number().int().positive(),
    vendorId: z.number().int().positive(),
    gradeId: z.number().int().positive(),
    qtyReceived: wholeUnits,
    goodsCostMinor: minorUnits,
    landedCostMinor: minorUnits.default(0),
    // Backdating is permitted (edge case) — stock received before the system went live.
    receivedAt: z.coerce.date(),
    reference: z.string().trim().max(120).optional(),
    funding: fundingSchema,
  }),
  tags: (input) => [
    tags.stock,
    tags.stockForProduct(input.productId),
    tags.summary,
    tags.cash,
  ],
  handler: ({ tx, user, input }) =>
    receiveStock(tx, user.id, {
      productId: input.productId,
      vendorId: input.vendorId,
      gradeId: input.gradeId,
      qtyReceived: input.qtyReceived,
      goodsCostMinor: input.goodsCostMinor,
      landedCostMinor: input.landedCostMinor,
      receivedAt: input.receivedAt,
      reference: input.reference,
      funding: input.funding,
    }),
});

export const addLandedCostAction = defineAction({
  name: "addLandedCost",
  role: "owner",
  schema: z.object({
    batchId: z.number().int().positive(),
    additionalCostMinor: z.number().int().positive(),
    reason: z.string().trim().min(1, { error: "Say what this cost is for." }).max(200),
    funding: fundingSchema.optional(),
  }),
  tags: (input) => [tags.stock, tags.batch(input.batchId), tags.summary, tags.cash],
  handler: ({ tx, user, input, idempotencyId }) =>
    addLandedCost(tx, user.id, { ...input, idempotencyId }),
});

export const correctBatchCostAction = defineAction({
  name: "correctBatchCost",
  role: "owner",
  schema: z.object({
    batchId: z.number().int().positive(),
    newGoodsCostMinor: minorUnits,
    reason: z.string().trim().min(1, { error: "Say why the cost is being corrected." }).max(200),
    funding: fundingSchema.optional(),
  }),
  tags: (input) => [tags.stock, tags.batch(input.batchId), tags.summary, tags.cash],
  handler: ({ tx, user, input, idempotencyId }) =>
    correctBatchCost(tx, user.id, { ...input, idempotencyId }),
});

/**
 * Note the input shape: there is NO refund amount. The refund is derived from the batch, so
 * partial credits and restocking fees are unrepresentable rather than merely discouraged
 * (FR-023, FR-023a).
 */
export const returnToVendorAction = defineAction({
  name: "returnToVendor",
  role: "owner",
  schema: z.object({
    batchId: z.number().int().positive(),
    quantity: wholeUnits,
    reason: z.string().trim().min(1, { error: "Say why these units are going back." }).max(200),
  }),
  tags: (input) => [tags.stock, tags.batch(input.batchId), tags.summary, tags.cash],
  handler: ({ tx, user, input, idempotencyId }) =>
    returnToVendor(tx, user.id, { ...input, idempotencyId }),
});

export const recordStockCountAction = defineAction({
  name: "recordStockCount",
  role: "owner",
  schema: z.object({
    counts: z
      .array(
        z.object({
          batchId: z.number().int().positive(),
          countedQty: z.number().int().nonnegative(),
        }),
      )
      .min(1, { error: "Count at least one batch." }),
    reason: z.string().trim().min(1, { error: "A reason is required." }).max(200),
  }),
  tags: () => [tags.stock, tags.summary],
  handler: ({ tx, user, input, idempotencyId }) =>
    recordStockCount(tx, user.id, { ...input, idempotencyId }),
});

export const recordWriteOffAction = defineAction({
  name: "recordWriteOff",
  role: "owner",
  schema: z.object({
    batchId: z.number().int().positive(),
    quantity: wholeUnits,
    reason: z.string().trim().min(1, { error: "A reason is required." }).max(200),
  }),
  tags: (input) => [tags.stock, tags.batch(input.batchId), tags.summary],
  handler: ({ tx, user, input, idempotencyId }) =>
    recordWriteOff(tx, user.id, { ...input, idempotencyId }),
});
