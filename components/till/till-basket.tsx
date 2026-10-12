"use client";

import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, parseMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";
import { StaleActionNotice, useRetryableAction } from "./retry-boundary";

/** Deliberately carries NO cost field — the server never sends one to the till (SC-010). */
export type AvailableBatch = {
  batchId: number;
  productId: number;
  productCode: string;
  productName: string;
  vendorName: string;
  gradeCode: string;
  qtyRemaining: number;
  receivedAt: string;
};

type SaleResult = {
  saleId: number;
  saleNumber: string;
  revenueMinor: number;
  lines: Array<{ saleLineId: number }>;
};

type BasketLine = {
  /** Local row id; unrelated to anything server-side. */
  rowId: number;
  batchId: number | null;
  quantity: number;
  price: string;
};

type Props = {
  batches: AvailableBatch[];
  action: (idempotencyKey: string, input: unknown) => Promise<ActionResult<SaleResult>>;
};

let nextRowId = 1;

export function TillBasket({ batches, action }: Props) {
  /**
   * ONE key per basket, generated at first render and held in a ref (D9).
   *
   * Regenerating per submit would defeat idempotency entirely: a double-tap on a slow
   * connection would carry two different keys and record two sales. It is replaced only after a
   * sale COMPLETES, when the next basket is genuinely a new operation.
   */
  const keyRef = useRef<string>(crypto.randomUUID());

  const [lines, setLines] = useState<BasketLine[]>([
    { rowId: nextRowId++, batchId: null, quantity: 1, price: "" },
  ]);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card">("cash");

  const { state, run, retry, reset } = useRetryableAction<unknown, SaleResult>(action);

  const byId = useMemo(
    () => new Map(batches.map((b) => [b.batchId, b])),
    [batches],
  );

  const totalMinor = lines.reduce(
    (sum, l) => sum + (parseMinor(l.price) ?? 0) * l.quantity,
    0,
  );

  const complete = lines.every(
    (l) => l.batchId !== null && l.quantity > 0 && parseMinor(l.price) !== null,
  );

  const overDrawn = lines.some((l) => {
    if (l.batchId === null) return false;
    const taken = lines
      .filter((x) => x.batchId === l.batchId)
      .reduce((s, x) => s + x.quantity, 0);
    return taken > (byId.get(l.batchId)?.qtyRemaining ?? 0);
  });

  function update(rowId: number, patch: Partial<BasketLine>) {
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, ...patch } : l)));
  }

  async function submit() {
    const result = await run(keyRef.current, {
      paymentMethod,
      lines: lines.map((l) => ({
        batchId: l.batchId,
        quantity: l.quantity,
        unitPriceMinor: parseMinor(l.price) ?? 0,
      })),
    });

    if (result?.ok) {
      // A new basket is a new operation and needs its own key.
      keyRef.current = crypto.randomUUID();
      setLines([{ rowId: nextRowId++, batchId: null, quantity: 1, price: "" }]);
    }
  }

  if (state.kind === "stale") {
    return <StaleActionNotice onRetry={() => void retry()} />;
  }

  const result = state.kind === "result" ? state.result : null;

  return (
    <div className="space-y-4">
      {result?.ok ? (
        <div
          role="status"
          className="rounded-lg border border-green-600/40 bg-green-50 p-4 dark:bg-green-950/30"
        >
          <p className="font-medium">Sale {result.data.saleNumber} recorded.</p>
          <p className="text-muted-foreground text-sm">
            Take {formatMinor(result.data.revenueMinor)}.
          </p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={reset}>
            Next customer
          </Button>
        </div>
      ) : null}

      {result && !result.ok ? (
        <p role="alert" className="text-destructive text-sm">
          {result.message}
          {result.correlationId ? ` (ref ${result.correlationId})` : null}
        </p>
      ) : null}

      <ul className="space-y-3">
        {lines.map((line) => {
          const chosen = line.batchId === null ? null : byId.get(line.batchId);
          return (
            <li key={line.rowId} className="space-y-3 rounded-lg border p-3">
              <div className="space-y-1.5">
                {/*
                  htmlFor/id throughout. Without the association a screen reader announces an
                  unlabelled combobox, and tapping the label does not focus the control — which
                  on a touch till is a usability problem as much as an accessibility one.
                */}
                <label htmlFor={`batch-${line.rowId}`} className="text-sm font-medium">
                  Item and batch
                </label>
                {/*
                  NO DEFAULT SELECTION (FR-018). The seller must consciously pick which batch
                  these units leave, because that choice is what the profit figure is built on.
                */}
                <select
                  id={`batch-${line.rowId}`}
                  value={line.batchId ?? ""}
                  onChange={(e) =>
                    update(line.rowId, {
                      batchId: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  // min-h-12 — a finger target, not a mouse target (FR-043).
                  className="border-input bg-background min-h-12 w-full rounded-md border px-3 text-base"
                >
                  <option value="">Choose a batch…</option>
                  {batches.map((b) => (
                    <option key={b.batchId} value={b.batchId}>
                      {b.productName} · {b.vendorName} · grade {b.gradeCode} · {b.qtyRemaining}{" "}
                      left
                    </option>
                  ))}
                </select>
                {chosen ? (
                  <p className="text-muted-foreground text-xs">
                    {chosen.productCode} · received{" "}
                    {new Date(chosen.receivedAt).toLocaleDateString()} · {chosen.qtyRemaining}{" "}
                    available
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={`qty-${line.rowId}`} className="text-sm font-medium">
                    Quantity
                  </label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-12 min-w-12 text-lg"
                      onClick={() =>
                        update(line.rowId, { quantity: Math.max(1, line.quantity - 1) })
                      }
                      aria-label="Decrease quantity"
                    >
                      −
                    </Button>
                    <Input
                      id={`qty-${line.rowId}`}
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) =>
                        update(line.rowId, { quantity: Math.max(1, Number(e.target.value)) })
                      }
                      className="min-h-12 text-center text-base"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-12 min-w-12 text-lg"
                      onClick={() => update(line.rowId, { quantity: line.quantity + 1 })}
                      aria-label="Increase quantity"
                    >
                      +
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor={`price-${line.rowId}`} className="text-sm font-medium">
                    Price each
                  </label>
                  <Input
                    id={`price-${line.rowId}`}
                    inputMode="decimal"
                    value={line.price}
                    onChange={(e) => update(line.rowId, { price: e.target.value })}
                    placeholder="0.00"
                    className="min-h-12 text-base"
                  />
                </div>
              </div>

              {lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() =>
                    setLines((prev) => prev.filter((l) => l.rowId !== line.rowId))
                  }
                >
                  Remove line
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        variant="outline"
        className="min-h-12 w-full"
        onClick={() =>
          setLines((prev) => [
            ...prev,
            { rowId: nextRowId++, batchId: null, quantity: 1, price: "" },
          ])
        }
      >
        Add another item
      </Button>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <span className="text-sm font-medium">Total</span>
        <span className="text-xl font-semibold tabular-nums">{formatMinor(totalMinor)}</span>
      </div>

      <div className="flex gap-2">
        {(["cash", "card"] as const).map((method) => (
          <Button
            key={method}
            type="button"
            variant={paymentMethod === method ? "default" : "outline"}
            className="min-h-12 flex-1 capitalize"
            onClick={() => setPaymentMethod(method)}
          >
            {method}
          </Button>
        ))}
      </div>

      {overDrawn ? (
        <p role="alert" className="text-destructive text-sm">
          One of these batches does not have that many units left.
        </p>
      ) : null}

      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base"
        disabled={!complete || overDrawn || state.kind === "pending"}
        onClick={() => void submit()}
      >
        {state.kind === "pending" ? "Recording…" : `Complete sale · ${formatMinor(totalMinor)}`}
      </Button>
    </div>
  );
}
