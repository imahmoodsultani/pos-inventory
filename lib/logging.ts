/**
 * Correlation ids and server-side error logging (T030, FR-044).
 *
 * The constitution requires that errors are logged with enough context to diagnose, while the
 * user sees nothing that leaks internals. The bridge is a correlation id: random, meaningless on
 * its own, shown to the user, and attached to the full server-side log line.
 *
 * Nothing here ever returns an error's message or stack to a caller.
 */

import { randomUUID } from "node:crypto";

export function newCorrelationId(): string {
  // Short enough that someone can read it down a phone line.
  return randomUUID().slice(0, 8).toUpperCase();
}

type LogContext = Record<string, unknown>;

/**
 * Redact anything that looks like a credential before it reaches a log sink. Connection strings
 * are the realistic risk here: a pg error on a failed connect can carry the whole DSN, password
 * included.
 */
function redact(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi, "$1***$2")
    .replace(/\b(password|secret|token|api[-_]?key)\b(\s*[:=]\s*)\S+/gi, "$1$2***");
}

function serialiseError(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redact(error.message),
      stack: error.stack,
      // Postgres driver errors carry these and they are the fastest route to a diagnosis.
      code: (error as { code?: string }).code,
      constraint: (error as { constraint?: string }).constraint,
      detail: redact((error as { detail?: string }).detail),
    };
  }
  return { message: redact(String(error)) };
}

/**
 * Log an unexpected failure and return the correlation id to hand back to the user.
 *
 * Call this ONLY for genuine INTERNAL errors. Expected domain failures — insufficient stock,
 * a funding mismatch — are values, not incidents, and logging them as errors trains everyone
 * to ignore the error log.
 */
export function logInternalError(
  action: string,
  error: unknown,
  context: LogContext = {},
): string {
  const correlationId = newCorrelationId();
  console.error(
    JSON.stringify({
      level: "error",
      correlationId,
      action,
      at: new Date().toISOString(),
      ...context,
      error: serialiseError(error),
    }),
  );
  return correlationId;
}

export function logWarning(action: string, message: string, context: LogContext = {}): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      action,
      at: new Date().toISOString(),
      message: redact(message),
      ...context,
    }),
  );
}
