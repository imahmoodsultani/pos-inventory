/**
 * DomainError lives in its own module, deliberately.
 *
 * It was originally exported from action-wrapper.ts, which imports lib/db — so every service
 * that threw a DomainError transitively opened a connection pool at import time, and unit
 * testing a pure service required DATABASE_URL to be set. A thrown-error type has no business
 * dragging the database in behind it.
 */

import type { ErrorCode } from "@/lib/types/action-result";

/**
 * Thrown by business handlers to signal an EXPECTED failure.
 *
 * Throwing is how a handler aborts its transaction — returning an error value would leave the
 * partial write committed. The action wrapper converts this back into an ActionResult after the
 * rollback, so the user sees "Only 2 units left in this batch" rather than a 500.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
