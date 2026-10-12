"use server";

/**
 * Till Server Actions (T064).
 *
 * ALL BASKET LINES GO IN ONE CALL. Server Actions dispatch sequentially per client, so an action
 * per scanned item would serialise the whole basket behind a round trip each — and would make a
 * partially-committed basket possible, which is worse than slow.
 */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import { recordSale, redactForRole } from "@/lib/services/sale";
import { recordSaleReturn, recordSaleVoid } from "@/lib/services/sale-reversal";

const wholeUnits = z
  .number()
  .int({ error: "Quantities must be whole units." })
  .positive({ error: "Quantity must be at least 1." });

export const recordSaleAction = defineAction({
  name: "recordSale",
  // "salesperson" means any signed-in staff member, which includes the owner.
  role: "salesperson",
  schema: z.object({
    paymentMethod: z.enum(["cash", "card"], { error: "Choose cash or card." }),
    lines: z
      .array(
        z.object({
          // EXPLICIT per line. There is no automatic batch selection (FR-018).
          batchId: z.number().int().positive({ error: "Choose which batch this came from." }),
          quantity: wholeUnits,
          // Deliberately only non-negative, NOT "at least cost": selling below cost is a
          // legitimate decision and must not be blocked (FR-017).
          unitPriceMinor: z.number().int().nonnegative(),
        }),
      )
      .min(1, { error: "Add at least one item." }),
  }),
  tags: () => [tags.stock, tags.summary, tags.cash],
  handler: async ({ tx, user, input }) => {
    const result = await recordSale(tx, user.id, input);
    // Strip cost and profit BEFORE the value leaves the server. A salesperson's response must
    // not contain the keys at all — hiding them in the UI leaves them in the RSC payload.
    return redactForRole(result, user.role);
  },
});

/** FR-021 — either an owner or a salesperson may record a return. */
export const recordSaleReturnAction = defineAction({
  name: "recordSaleReturn",
  role: "salesperson",
  schema: z.object({
    saleId: z.number().int().positive(),
    lines: z
      .array(
        z.object({
          saleLineId: z.number().int().positive(),
          quantity: wholeUnits,
        }),
      )
      .min(1, { error: "Choose what is coming back." }),
    reason: z.string().trim().min(1, { error: "A reason is required." }).max(200),
  }),
  tags: () => [tags.stock, tags.summary, tags.cash],
  handler: ({ tx, user, input, idempotencyId }) =>
    // The service decides what the result carries based on role.
    recordSaleReturn(tx, user.id, user.role, { ...input, idempotencyId }),
});

/**
 * FR-022 — voiding is OWNER ONLY.
 *
 * The asymmetry with returns is deliberate: a salesperson can undo a customer's purchase, where
 * cash visibly moves, but cannot make a whole sale disappear from the day's takings.
 */
export const recordSaleVoidAction = defineAction({
  name: "recordSaleVoid",
  role: "owner",
  schema: z.object({
    saleId: z.number().int().positive(),
    reason: z.string().trim().min(1, { error: "Say why this sale is being voided." }).max(200),
  }),
  tags: () => [tags.stock, tags.summary, tags.cash],
  handler: ({ tx, user, input, idempotencyId }) =>
    recordSaleVoid(tx, user.id, { ...input, idempotencyId }),
});
