"use server";

/** Vendor Server Actions (T043). Owner only. */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import {
  createVendor,
  deactivateVendor,
  deleteVendor,
  updateVendor,
} from "@/lib/services/catalogue";

export const createVendorAction = defineAction({
  name: "createVendor",
  role: "owner",
  schema: z.object({
    // Unique case-insensitively — "Acme" and "ACME" are the same supplier, and two rows for one
    // supplier would split their margin report in half.
    name: z.string().trim().min(1, { error: "A vendor name is required." }).max(160),
    phone: z.string().trim().max(40).optional(),
    email: z.email({ error: "That does not look like an email address." }).optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
  tags: () => [tags.catalogue],
  handler: ({ tx, user, input }) => createVendor(tx, user.id, input),
});

/** FR-045 — correcting a vendor after creation, including when batches reference it. */
export const updateVendorAction = defineAction({
  name: "updateVendor",
  role: "owner",
  schema: z.object({
    vendorId: z.number().int().positive(),
    name: z.string().trim().min(1, { error: "A vendor name is required." }).max(160).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.email({ error: "That does not look like an email address." }).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  }),
  tags: () => [tags.catalogue, tags.stock],
  handler: ({ tx, user, input }) => updateVendor(tx, user.id, input),
});

export const deactivateVendorAction = defineAction({
  name: "deactivateVendor",
  role: "owner",
  schema: z.object({ vendorId: z.number().int().positive() }),
  tags: () => [tags.catalogue],
  handler: ({ tx, user, input }) => deactivateVendor(tx, user.id, input),
});

/** Always CONFLICT (FR-004) — see the note on deleteProductAction. */
export const deleteVendorAction = defineAction({
  name: "deleteVendor",
  role: "owner",
  schema: z.object({ vendorId: z.number().int().positive() }),
  handler: ({ tx, user, input }) => deleteVendor(tx, user.id, input),
});
