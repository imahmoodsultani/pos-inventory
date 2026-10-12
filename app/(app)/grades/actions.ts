"use server";

/** Quality grade Server Actions (T044). Owner only. */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import {
  createQualityGrade,
  deleteQualityGrade,
  updateQualityGrade,
} from "@/lib/services/catalogue";

export const createQualityGradeAction = defineAction({
  name: "createQualityGrade",
  role: "owner",
  schema: z.object({
    code: z.string().trim().min(1, { error: "A short code is required." }).max(20),
    label: z.string().trim().min(1, { error: "A label is required." }).max(80),
    // Controls the order grades appear in at the till, where speed matters more than alphabet.
    sortOrder: z.number().int().nonnegative().default(0),
  }),
  tags: () => [tags.catalogue],
  handler: ({ tx, user, input }) => createQualityGrade(tx, user.id, input),
});

/**
 * FR-045 — label and sort order only. `code` is absent by design: it appears against historical
 * sale lines, and changing it would relabel what past sales were graded as.
 */
export const updateQualityGradeAction = defineAction({
  name: "updateQualityGrade",
  role: "owner",
  schema: z.object({
    gradeId: z.number().int().positive(),
    label: z.string().trim().min(1, { error: "A label is required." }).max(80).optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  }),
  tags: () => [tags.catalogue],
  handler: ({ tx, user, input }) => updateQualityGrade(tx, user.id, input),
});

/** Always CONFLICT (FR-004) — see the note on deleteProductAction. */
export const deleteQualityGradeAction = defineAction({
  name: "deleteQualityGrade",
  role: "owner",
  schema: z.object({ gradeId: z.number().int().positive() }),
  handler: ({ tx, user, input }) => deleteQualityGrade(tx, user.id, input),
});
