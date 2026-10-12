"use server";

/** Capital Server Actions (T078). Owner only — these move the owner's own money. */

import { z } from "zod";

import { tags } from "@/lib/cache-tags";
import { defineAction } from "@/lib/services/action-wrapper";
import { recordCapitalInjection, recordWithdrawal } from "@/lib/services/capital";

const schema = z.object({
  amountMinor: z
    .number()
    .int({ error: "Amounts must be whole minor units." })
    .positive({ error: "Enter an amount greater than zero." }),
  occurredAt: z.coerce.date(),
  note: z.string().trim().max(500).optional(),
});

export const recordCapitalInjectionAction = defineAction({
  name: "recordCapitalInjection",
  role: "owner",
  schema,
  tags: () => [tags.summary, tags.cash],
  handler: ({ tx, user, input }) => recordCapitalInjection(tx, user.id, input),
});

export const recordWithdrawalAction = defineAction({
  name: "recordWithdrawal",
  role: "owner",
  schema,
  tags: () => [tags.summary, tags.cash],
  handler: ({ tx, user, input }) => recordWithdrawal(tx, user.id, input),
});
