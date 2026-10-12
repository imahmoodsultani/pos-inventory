"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, parseMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";

type CostChangeResult = {
  batchId: number;
  totalCostMinor: number;
  adjustmentMinor: number;
  adjustmentMovementId: number | null;
};

type Action = (key: string, input: unknown) => Promise<ActionResult<CostChangeResult>>;

export function CorrectionForm({
  batchId,
  goodsCostMinor,
  consumed,
  addLandedCost,
  correctBatchCost,
}: {
  batchId: number;
  goodsCostMinor: number;
  consumed: number;
  addLandedCost: Action;
  correctBatchCost: Action;
}) {
  const router = useRouter();
  const landedKey = useRef<string>(crypto.randomUUID());
  const correctKey = useRef<string>(crypto.randomUUID());

  const [landed, setLanded] = useState("");
  const [newGoods, setNewGoods] = useState(formatMinor(goodsCostMinor));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function run(action: Action, keyRef: { current: string }, input: unknown) {
    setPending(true);
    setMessage(null);
    const result = await action(keyRef.current, input);
    setPending(false);

    if (result.ok) {
      keyRef.current = crypto.randomUUID();
      setReason("");
      setLanded("");
      setMessage({
        tone: "ok",
        text:
          `Batch cost is now ${formatMinor(result.data.totalCostMinor)}.` +
          (result.data.adjustmentMinor !== 0
            ? ` ${formatMinor(Math.abs(result.data.adjustmentMinor))} of that belonged to units ` +
              `already sold and has been booked as a dated adjustment — past sales keep their ` +
              `original cost.`
            : " Nothing had been sold yet, so the whole change applies to the units still in stock."),
      });
      router.refresh();
    } else {
      setMessage({ tone: "bad", text: result.message });
    }
  }

  return (
    <div className="space-y-5">
      {consumed > 0 ? (
        <p className="rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          {consumed} unit{consumed === 1 ? " has" : "s have"} already been sold from this batch.
          Changing the cost will <strong>not</strong> rewrite what those sales earned — the
          difference attributable to them is recorded as a separate dated adjustment instead.
        </p>
      ) : null}

      {message ? (
        <p
          role={message.tone === "bad" ? "alert" : "status"}
          className={
            message.tone === "bad"
              ? "text-destructive text-sm"
              : "text-sm text-green-700 dark:text-green-400"
          }
        >
          {message.text}
        </p>
      ) : null}

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">Add a landed cost</h2>
        <p className="text-muted-foreground text-sm">
          Freight, duty or handling that arrived after the goods. Added on top of the current cost.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="landed" className="text-sm font-medium">Amount to add</label>
          <Input id="landed" inputMode="decimal" value={landed}
            onChange={(e) => setLanded(e.target.value)} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="landed-reason" className="text-sm font-medium">What is it for?</label>
          <Input id="landed-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            maxLength={200} placeholder="Freight invoice from the carrier" />
        </div>
        <Button
          type="button"
          disabled={pending || !parseMinor(landed) || reason.trim() === ""}
          onClick={() =>
            void run(addLandedCost, landedKey, {
              batchId,
              additionalCostMinor: parseMinor(landed) ?? 0,
              reason,
            })
          }
        >
          {pending ? "Recording…" : "Add landed cost"}
        </Button>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">Correct the goods cost</h2>
        <p className="text-muted-foreground text-sm">
          For a rate entered wrongly. Replaces the goods cost; any landed cost is left alone.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="goods" className="text-sm font-medium">Correct goods cost</label>
          <Input id="goods" inputMode="decimal" value={newGoods}
            onChange={(e) => setNewGoods(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="correct-reason" className="text-sm font-medium">Why is it being corrected?</label>
          <Input id="correct-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            maxLength={200} placeholder="Rate was entered as 1200 instead of 1020" />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={
            pending ||
            parseMinor(newGoods) === null ||
            parseMinor(newGoods) === goodsCostMinor ||
            reason.trim() === ""
          }
          onClick={() =>
            void run(correctBatchCost, correctKey, {
              batchId,
              newGoodsCostMinor: parseMinor(newGoods) ?? 0,
              reason,
            })
          }
        >
          {pending ? "Recording…" : "Correct cost"}
        </Button>
      </section>
    </div>
  );
}
