"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, parseMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";

export type CapitalEventRow = {
  id: number;
  eventType: string;
  amountMinor: number;
  occurredAt: string;
  note: string | null;
  /** Newest first. Empty when the entry has never been corrected. */
  edits: Array<{
    id: number;
    fieldName: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string | null;
    changedAt: string;
  }>;
};

type Action = (key: string, input: unknown) => Promise<ActionResult<unknown>>;

export function CapitalHistory({
  events,
  correctAction,
}: {
  events: CapitalEventRow[];
  correctAction: Action;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing(event: CapitalEventRow) {
    setEditing(event.id);
    setAmount(formatMinor(event.amountMinor));
    setReason("");
    setError(null);
  }

  async function submit(event: CapitalEventRow) {
    setPending(true);
    setError(null);
    // A fresh key per attempt is correct here: a correction is idempotent by nature (the same
    // values produce the same row), and reusing one across edits would replay a stale response.
    const result = await correctAction(crypto.randomUUID(), {
      eventId: event.id,
      amountMinor: parseMinor(amount) ?? 0,
      occurredAt: event.occurredAt,
      note: event.note,
      reason,
    });
    setPending(false);

    if (result.ok) {
      setEditing(null);
      router.refresh();
    } else {
      // The refusal names the available balance and how far the entry can move — shown verbatim.
      setError(result.message);
    }
  }

  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing recorded yet. Put money in above to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {events.map((event) => {
        const isWithdrawal = event.eventType === "withdrawal";
        return (
          <li key={event.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm">
                <span className="font-medium capitalize">{event.eventType}</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {new Date(event.occurredAt).toLocaleDateString()}
                </span>
                {event.note ? (
                  <span className="text-muted-foreground block text-xs">{event.note}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-3">
                <span className={`tabular-nums ${isWithdrawal ? "text-destructive" : ""}`}>
                  {isWithdrawal ? "−" : "+"}
                  {formatMinor(event.amountMinor)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (editing === event.id ? setEditing(null) : startEditing(event))}
                >
                  {editing === event.id ? "Cancel" : "Correct"}
                </Button>
              </span>
            </div>

            {editing === event.id ? (
              <div className="mt-3 space-y-3 rounded-lg border p-3">
                <p className="text-muted-foreground text-xs">
                  Correcting replaces the amount. Cash on hand and capital{" "}
                  {isWithdrawal ? "recovered" : "invested"} both move by the difference.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor={`amount-${event.id}`} className="text-sm font-medium">
                      Correct amount
                    </label>
                    <Input
                      id={`amount-${event.id}`}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`reason-${event.id}`} className="text-sm font-medium">
                      Why?
                    </label>
                    <Input
                      id={`reason-${event.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={200}
                      placeholder="Typed an extra zero"
                    />
                  </div>
                </div>
                {error ? (
                  <p role="alert" className="text-destructive text-sm">
                    {error}
                  </p>
                ) : null}
                <Button
                  disabled={pending || reason.trim() === "" || parseMinor(amount) === null}
                  onClick={() => void submit(event)}
                >
                  {pending ? "Correcting…" : "Save correction"}
                </Button>
              </div>
            ) : null}

            {/*
              Shown inline, not on a separate page. A corrected entry must READ as corrected —
              otherwise the new figure looks like it was always that value, and the owner has no
              way to reconcile it against whatever they acted on last week.
            */}
            {event.edits.length > 0 ? (
              <ul className="text-muted-foreground mt-2 space-y-0.5 border-l-2 pl-3 text-xs">
                {event.edits.map((edit) => (
                  <li key={edit.id}>
                    {edit.fieldName === "amountMinor" ? (
                      <>
                        was {formatMinor(Number(edit.oldValue ?? 0))}, corrected to{" "}
                        {formatMinor(Number(edit.newValue ?? 0))}
                      </>
                    ) : (
                      <>
                        {edit.fieldName} changed
                      </>
                    )}
                    {edit.reason ? ` — ${edit.reason}` : null}
                    {" · "}
                    {new Date(edit.changedAt).toLocaleDateString()}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
