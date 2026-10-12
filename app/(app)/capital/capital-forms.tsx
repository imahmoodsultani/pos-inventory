"use client";

import { useActionState, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, parseMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";

type CapitalResult = {
  eventId: number;
  cashOnHandMinor: number;
  capitalInvestedMinor: number;
  capitalRecoveredMinor: number;
};

type Action = (key: string, input: unknown) => Promise<ActionResult<CapitalResult>>;

export function CapitalForm({
  kind,
  action,
  cashOnHandMinor,
}: {
  kind: "injection" | "withdrawal";
  action: Action;
  cashOnHandMinor: number;
}) {
  const isWithdrawal = kind === "withdrawal";

  // One key per form instance, replaced only after a successful submit (D9).
  const keyRef = useRef<string>(crypto.randomUUID());

  const [state, formAction, pending] = useActionState<
    ActionResult<CapitalResult> | null,
    FormData
  >(async (_prev, formData) => {
    const result = await action(keyRef.current, {
      amountMinor: parseMinor(String(formData.get("amount") ?? "")) ?? 0,
      occurredAt: String(formData.get("occurredAt") || new Date().toISOString()),
      note: String(formData.get("note") ?? "") || undefined,
    });
    if (result.ok) keyRef.current = crypto.randomUUID();
    return result;
  }, null);

  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="font-medium">{isWithdrawal ? "Take money out" : "Put money in"}</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {isWithdrawal
            ? `Recorded as capital recovered. At most ${formatMinor(cashOnHandMinor)} is available.`
            : "Recorded as capital invested."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${kind}-amount`} className="text-sm font-medium">
            Amount
          </label>
          <Input
            id={`${kind}-amount`}
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            required
          />
          {fieldErrors.amountMinor?.length ? (
            <p className="text-destructive text-xs">{fieldErrors.amountMinor.join(". ")}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${kind}-date`} className="text-sm font-medium">
            Date
          </label>
          <Input
            id={`${kind}-date`}
            name="occurredAt"
            type="datetime-local"
            defaultValue={new Date().toISOString().slice(0, 16)}
            required
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${kind}-note`} className="text-sm font-medium">
          Note
        </label>
        <Input id={`${kind}-note`} name="note" maxLength={500} />
      </div>

      {state && !state.ok ? (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
          {state.correlationId ? ` (ref ${state.correlationId})` : null}
        </p>
      ) : null}

      {state?.ok ? (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Recorded. Cash on hand is now {formatMinor(state.data.cashOnHandMinor)}.
        </p>
      ) : null}

      <Button type="submit" disabled={pending} variant={isWithdrawal ? "outline" : "default"}>
        {pending ? "Recording…" : isWithdrawal ? "Record withdrawal" : "Record injection"}
      </Button>
    </form>
  );
}
