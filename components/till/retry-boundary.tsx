"use client";

/**
 * "Failed to find Server Action" recovery (T068).
 *
 * THIS IS A NORMAL FLOW, NOT AN EDGE CASE. Server Action ids are derived from the build; when a
 * deploy ships, ids from the previous build stop resolving. A till is a tab left open all day,
 * so it WILL outlive a deploy, and the cashier gets an opaque failure mid-sale.
 *
 * The recovery is safe specifically because the retry reuses THE SAME IDEMPOTENCY KEY. If the
 * original request had already committed server-side before the connection broke, the retry
 * replays the stored response instead of recording a second sale. Without that, a retry button
 * here would be a duplicate-sale button.
 */

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/types/action-result";

/** Next.js throws this when an action id from a previous build no longer resolves. */
export function isStaleActionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Failed to find Server Action") ||
    message.includes("Could not find the module") ||
    // A deploy mid-request can also surface as a failed fetch for the action endpoint.
    message.includes("Failed to fetch")
  );
}

export type SubmitState<T> =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "result"; result: ActionResult<T> }
  | { kind: "stale" };

/**
 * Runs an action, catching the stale-action case and exposing a retry that reuses the key.
 *
 * Returns `stale` rather than throwing so the caller can render a plain, honest message
 * ("The app updated — tap to retry") instead of an error overlay mid-sale.
 */
export function useRetryableAction<TInput, TOutput>(
  action: (idempotencyKey: string, input: TInput) => Promise<ActionResult<TOutput>>,
) {
  const [state, setState] = useState<SubmitState<TOutput>>({ kind: "idle" });
  const [lastAttempt, setLastAttempt] = useState<{ key: string; input: TInput } | null>(null);

  const run = useCallback(
    async (key: string, input: TInput) => {
      setLastAttempt({ key, input });
      setState({ kind: "pending" });
      try {
        const result = await action(key, input);
        setState({ kind: "result", result });
        return result;
      } catch (error) {
        if (isStaleActionError(error)) {
          setState({ kind: "stale" });
          return null;
        }
        throw error;
      }
    },
    [action],
  );

  const retry = useCallback(async () => {
    if (!lastAttempt) return null;
    // SAME KEY. This is what makes the retry safe.
    return run(lastAttempt.key, lastAttempt.input);
  }, [lastAttempt, run]);

  const reset = useCallback(() => setState({ kind: "idle" }), []);

  return { state, run, retry, reset };
}

export function StaleActionNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-50 p-4 dark:bg-amber-950/30">
      <p className="text-sm font-medium">The app updated while this tab was open.</p>
      <p className="text-muted-foreground text-sm">
        Your basket is safe. Tap retry — if the sale already went through, it will not be
        recorded twice.
      </p>
      <Button onClick={onRetry} size="lg" className="min-h-12">
        Retry
      </Button>
    </div>
  );
}
