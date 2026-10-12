"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/types/action-result";

type Action = (key: string, input: unknown) => Promise<ActionResult<unknown>>;

export type CountableBatch = {
  batchId: number;
  productName: string;
  productCode: string;
  vendorName: string;
  gradeCode: string;
  qtyRemaining: number;
  qtyReceived: number;
};

/**
 * Physical stock count (FR-049).
 *
 * The screen is built around one fact: the person is standing at a shelf with the goods in front
 * of them. So the input is WHAT THEY COUNTED, never a delta — asking for "−2" means doing the
 * arithmetic in their head against a figure they are in the middle of disproving.
 *
 * Only batches whose counted figure differs are submitted. Counting fifty batches and finding two
 * discrepancies should write two adjustments, not fifty no-ops.
 */
export function CountForm({
  batches,
  action,
}: {
  batches: CountableBatch[];
  action: Action;
}) {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const changed = batches.filter((b) => {
    const raw = counts[b.batchId];
    if (raw === undefined || raw === "") return false;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value !== b.qtyRemaining;
  });

  async function submit() {
    setPending(true);
    setError(null);
    setDone(null);

    const result = await action(crypto.randomUUID(), {
      counts: changed.map((b) => ({
        batchId: b.batchId,
        countedQty: Number(counts[b.batchId]),
      })),
      reason,
    });
    setPending(false);

    if (result.ok) {
      setCounts({});
      setReason("");
      setDone(
        `Recorded ${changed.length} adjustment${changed.length === 1 ? "" : "s"}. ` +
          "Stock figures below are already updated.",
      );
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  if (batches.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        No stock on hand to count.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-lg border">
        {batches.map((batch) => {
          const raw = counts[batch.batchId] ?? "";
          const value = raw === "" ? null : Number(raw);
          const delta = value === null ? null : value - batch.qtyRemaining;
          const invalid =
            value !== null &&
            (!Number.isInteger(value) || value < 0 || value > batch.qtyReceived);

          return (
            <li
              key={batch.batchId}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="text-sm">
                <span className="font-medium">{batch.productName}</span>
                <span className="text-muted-foreground block text-xs">
                  {batch.productCode} · {batch.vendorName} · grade {batch.gradeCode} · batch{" "}
                  {batch.batchId}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-sm tabular-nums">
                  expected {batch.qtyRemaining}
                </span>
                <div className="space-y-1">
                  <label
                    htmlFor={`counted-${batch.batchId}`}
                    className="sr-only"
                  >
                    Counted quantity for batch {batch.batchId}
                  </label>
                  <Input
                    id={`counted-${batch.batchId}`}
                    type="number"
                    min={0}
                    max={batch.qtyReceived}
                    inputMode="numeric"
                    className="w-24"
                    placeholder="count"
                    value={raw}
                    onChange={(e) =>
                      setCounts((c) => ({ ...c, [batch.batchId]: e.target.value }))
                    }
                  />
                </div>
                <span className="w-24 text-right text-sm tabular-nums">
                  {invalid ? (
                    <span className="text-destructive text-xs">
                      0–{batch.qtyReceived}
                    </span>
                  ) : delta === null || delta === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={delta < 0 ? "text-destructive" : "text-green-700"}>
                      {delta > 0 ? "+" : ""}
                      {delta}
                    </span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="space-y-1.5">
        <label htmlFor="count-reason" className="text-sm font-medium">
          Why? <span className="text-muted-foreground font-normal">(required)</span>
        </label>
        <Input
          id="count-reason"
          value={reason}
          maxLength={200}
          placeholder="Monthly count"
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Stored against every adjustment this count writes, so the movement history explains
          itself later.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {done}
        </p>
      ) : null}

      <Button disabled={pending || changed.length === 0 || reason.trim() === ""} onClick={() => void submit()}>
        {pending
          ? "Recording…"
          : changed.length === 0
            ? "No differences to record"
            : `Record ${changed.length} adjustment${changed.length === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}
