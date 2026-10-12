"use server";

/** Staff account Server Actions (T099). Owner only — these grant and revoke access. */

import { z } from "zod";

import { defineAction } from "@/lib/services/action-wrapper";
import {
  createStaffUser,
  resetUserPassword,
  setUserActive,
  setUserRole,
  updateStaffDetails,
} from "@/lib/services/users";

// Matches lib/auth/config.ts. Enforced here too so the error is a field error rather than an
// opaque failure from deep inside Better Auth.
const password = z
  .string()
  .min(10, { error: "Use at least 10 characters." })
  .max(200);

const role = z.enum(["owner", "salesperson"], { error: "Choose a role." });

export const createStaffUserAction = defineAction({
  name: "createStaffUser",
  role: "owner",
  schema: z.object({
    email: z.email({ error: "That does not look like an email address." }),
    name: z.string().trim().min(1, { error: "A name is required." }).max(160),
    password,
    role,
  }),
  handler: ({ tx, user, input }) => createStaffUser(tx, user.id, input),
});

/** FR-047 — correcting a staff member's name or sign-in email after the account exists. */
export const updateStaffDetailsAction = defineAction({
  name: "updateStaffDetails",
  role: "owner",
  schema: z.object({
    userId: z.string().min(1),
    name: z.string().trim().min(1, { error: "A name is required." }).max(160).optional(),
    email: z.email({ error: "That does not look like an email address." }).optional(),
  }),
  handler: ({ tx, user, input }) => updateStaffDetails(tx, user.id, input),
});

export const setUserActiveAction = defineAction({
  name: "setUserActive",
  role: "owner",
  schema: z.object({ userId: z.string().min(1), isActive: z.boolean() }),
  handler: ({ tx, user, input }) => setUserActive(tx, user.id, input),
});

export const setUserRoleAction = defineAction({
  name: "setUserRole",
  role: "owner",
  schema: z.object({ userId: z.string().min(1), role }),
  handler: ({ tx, user, input }) => setUserRole(tx, user.id, input),
});

export const resetUserPasswordAction = defineAction({
  name: "resetUserPassword",
  role: "owner",
  schema: z.object({ userId: z.string().min(1), password }),
  handler: ({ tx, user, input }) => resetUserPassword(tx, user.id, input),
});
