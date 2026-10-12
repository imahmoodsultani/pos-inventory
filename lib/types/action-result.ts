/**
 * The result type every Server Action returns (T029, contracts/server-actions.md).
 *
 * Expected failures are VALUES, not exceptions. Two reasons this is not a style preference:
 *
 *   1. Next.js replaces thrown errors with opaque digests in production, so "Only 2 units left"
 *      would reach the cashier as "An error occurred in the Server Components render".
 *   2. `useActionState` needs a serialisable value to render field errors against.
 *
 * Only genuine 500s throw. Note that `redirect()` works BY throwing, so any redirect inside a
 * try/catch must be re-thrown via `unstable_rethrow` or it will be swallowed as an INTERNAL.
 */

export type ErrorCode =
  /** No valid session. */
  | "UNAUTHENTICATED"
  /** Authenticated, but the wrong role. */
  | "FORBIDDEN"
  /** Zod failure; `fieldErrors` is populated. */
  | "VALIDATION"
  /** The guarded conditional UPDATE matched zero rows — someone else took the stock. */
  | "INSUFFICIENT_STOCK"
  /** Would drive cash_on_hand negative (FR-031). */
  | "INSUFFICIENT_CASH"
  /** new_capital + reinvested !== total_cost_minor (FR-026). */
  | "FUNDING_MISMATCH"
  /** Same idempotency key, different payload hash. */
  | "IDEMPOTENCY_CONFLICT"
  /** A duplicate arrived while the first attempt is still running; the client should retry. */
  | "IN_FLIGHT"
  | "NOT_FOUND"
  /** Invalid state transition, e.g. voiding an already-voided sale. */
  | "CONFLICT"
  | "INTERNAL";

export type ActionOk<T> = { ok: true; data: T };

export type ActionErr = {
  ok: false;
  code: ErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
  /** Present on INTERNAL only: shown to the user so a report can be traced to a server log. */
  correlationId?: string;
};

export type ActionResult<T> = ActionOk<T> | ActionErr;

export function ok<T>(data: T): ActionOk<T> {
  return { ok: true, data };
}

export function err(
  code: ErrorCode,
  message: string,
  extra?: { fieldErrors?: Record<string, string[]>; correlationId?: string },
): ActionErr {
  return { ok: false, code, message, ...extra };
}

/** Narrowing helper for callers and tests. */
export function isOk<T>(result: ActionResult<T>): result is ActionOk<T> {
  return result.ok;
}

/**
 * Error messages are user-facing (FR-044): say what happened and what to do, name real numbers,
 * and never leak SQL, stack traces, or secrets.
 */
export const messages = {
  unauthenticated: "Your session has ended. Sign in again to continue.",
  forbidden: "You do not have permission to do this.",
  insufficientStock: (available: number, requested: number) =>
    `Only ${available} left in this batch — you asked for ${requested}.`,
  insufficientCash: (availableMinor: number) =>
    `Not enough cash on hand. Available: ${availableMinor} (minor units).`,
  fundingMismatch: (differenceMinor: number) =>
    `The funding split is off by ${differenceMinor} (minor units). New capital plus reinvested ` +
    `revenue must equal the total cost of the purchase.`,
  idempotencyConflict:
    "This form was already submitted with different details. Reload the page and try again.",
  inFlight: "This is still being processed. Wait a moment and try again.",
  internal: (correlationId: string) =>
    `Something went wrong on our side. Quote reference ${correlationId} if you report this.`,
} as const;
