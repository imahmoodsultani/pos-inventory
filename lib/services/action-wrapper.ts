import "server-only";

/**
 * The mandatory Server Action preamble (T032, contracts/server-actions.md).
 *
 * Every mutating action runs the same five steps, in this order:
 *
 *   1. verifySession()                    → UNAUTHENTICATED
 *   2. role check                         → FORBIDDEN
 *   3. Zod 4 parse                        → VALIDATION (z.treeifyError)
 *   4. ONE transaction: claim the idempotency key, then do the business write
 *   5. updateTag() after commit           → never revalidateTag
 *
 * Centralising it is not about tidiness. A Server Action is a public POST endpoint whose id
 * ships in the client bundle; an action that forgets step 1 or 2 is an unauthenticated write
 * endpoint, and that mistake is invisible in review. Here it is impossible to express.
 */

import { updateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { treeifyError, type z } from "zod";

import { db, pool, type Tx } from "@/lib/db";
import {
  ForbiddenError,
  UnauthenticatedError,
  requireRole,
  type Role,
  type SessionUser,
} from "@/lib/dal/session";
import { logInternalError } from "@/lib/logging";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from "@/lib/services/idempotency";
import { DomainError } from "@/lib/services/domain-error";
import { err, messages, ok, type ActionResult } from "@/lib/types/action-result";

// Defined in its own module so services can throw it without importing lib/db.
export { DomainError } from "@/lib/services/domain-error";

export type ActionContext<TInput> = {
  tx: Tx;
  user: SessionUser;
  input: TInput;
  /**
   * The id of the idempotency_keys row claimed for THIS call.
   *
   * Used as a monotonic, per-operation identifier for ledger rows that need one — notably the
   * FR-007a cost-correction movement, whose (ref_type, ref_id, batch_id) must differ between two
   * corrections of the same batch but collide on a genuine retry. See data-model.md §5.
   */
  idempotencyId: number;
};

export type ActionDefinition<TSchema extends z.ZodType, TOutput> = {
  /** Used in logs and as the stored action_name. */
  name: string;
  /** "owner" requires owner; "salesperson" accepts any signed-in staff member. */
  role: Role;
  schema: TSchema;
  /** Cache tags to update AFTER the commit. */
  tags?: (input: z.output<TSchema>, result: TOutput) => string[];
  handler: (ctx: ActionContext<z.output<TSchema>>) => Promise<TOutput>;
};

export function defineAction<TSchema extends z.ZodType, TOutput>(
  definition: ActionDefinition<TSchema, TOutput>,
): (idempotencyKey: string, rawInput: unknown) => Promise<ActionResult<TOutput>> {
  return async function action(idempotencyKey, rawInput) {
    let user: SessionUser;

    // --- Steps 1 and 2: identity and role, before anything is read or parsed. ---
    try {
      user = await requireRole(definition.role);
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof UnauthenticatedError) {
        return err("UNAUTHENTICATED", messages.unauthenticated);
      }
      if (error instanceof ForbiddenError) {
        return err("FORBIDDEN", messages.forbidden);
      }
      const correlationId = logInternalError(definition.name, error, { phase: "auth" });
      return err("INTERNAL", messages.internal(correlationId), { correlationId });
    }

    // --- Step 3: validation. Zod 4 — `z.treeifyError`, not the removed Zod 3 options. ---
    const parsed = definition.schema.safeParse(rawInput);
    if (!parsed.success) {
      const tree = treeifyError(parsed.error) as {
        properties?: Record<string, { errors?: string[] }>;
      };
      const fieldErrors: Record<string, string[]> = {};
      for (const [field, node] of Object.entries(tree.properties ?? {})) {
        if (node?.errors?.length) fieldErrors[field] = node.errors;
      }
      return err("VALIDATION", "Please correct the highlighted fields.", { fieldErrors });
    }
    const input = parsed.data as z.output<TSchema>;

    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return err("VALIDATION", "Missing or malformed idempotency key.");
    }

    const requestHash = hashRequest(input);
    // Scoped per user so two tills can independently generate the same UUID without colliding.
    const scope = user.id;
    let claimedId: number | undefined;

    try {
      // --- Step 4: ONE transaction. The claim and the business write commit together. ---
      const outcome = await db.transaction(async (tx) => {
        const claim = await claimIdempotencyKey(tx as Tx, {
          scope,
          key: idempotencyKey,
          actionName: definition.name,
          requestHash,
        });

        if (claim.status === "conflict") {
          return { kind: "conflict" as const };
        }
        if (claim.status === "in_flight") {
          return { kind: "in_flight" as const };
        }
        if (claim.status === "replay") {
          return { kind: "replay" as const, data: claim.responseBody as TOutput };
        }

        claimedId = claim.id;
        const data = await definition.handler({
          tx: tx as Tx,
          user,
          input,
          idempotencyId: claim.id,
        });
        await completeIdempotencyKey(tx as Tx, claim.id, data);
        return { kind: "done" as const, data };
      });

      if (outcome.kind === "conflict") {
        return err("IDEMPOTENCY_CONFLICT", messages.idempotencyConflict);
      }
      if (outcome.kind === "in_flight") {
        return err("IN_FLIGHT", messages.inFlight);
      }

      // --- Step 5: cache invalidation, AFTER the commit. ---
      //
      // updateTag, never revalidateTag. revalidateTag is stale-while-revalidate: the cashier who
      // just completed a sale would be served the pre-sale stock count — their own write,
      // invisible to them. A replay invalidates too, since the caller still needs fresh data.
      for (const tag of definition.tags?.(input, outcome.data) ?? []) {
        updateTag(tag);
      }

      return ok(outcome.data);
    } catch (error) {
      // redirect() and notFound() work by throwing; swallowing them would break navigation.
      unstable_rethrow(error);

      // The transaction has rolled back, including the key claim. Mark it failed on a SEPARATE
      // connection — an UPDATE on the aborted transaction would be discarded with it.
      if (claimedId !== undefined) {
        await markFailedOutOfBand(claimedId);
      }

      if (error instanceof DomainError) {
        return err(error.code, error.message, { fieldErrors: error.fieldErrors });
      }

      const correlationId = logInternalError(definition.name, error, {
        userId: user.id,
        actionName: definition.name,
      });
      return err("INTERNAL", messages.internal(correlationId), { correlationId });
    }
  };
}

/**
 * Best-effort: the claim row was rolled back with the transaction, so there is usually nothing
 * to update. This exists for the case where the row survived (a handler that caught and
 * committed), and must never mask the original error.
 */
async function markFailedOutOfBand(id: number): Promise<void> {
  try {
    // Straight through the pool, deliberately NOT through `db.transaction` — the caller's
    // transaction is aborted and anything run on it would be discarded.
    await pool.query(
      "UPDATE idempotency_keys SET status = 'failed' WHERE id = $1 AND status = 'in_progress'",
      [id],
    );
  } catch {
    // Swallow: the key expires in 72h regardless, and the caller's real error matters more.
  }
}
