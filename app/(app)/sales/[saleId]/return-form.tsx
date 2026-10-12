"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";

export type ReturnableLine = {
  saleLineId: number;
  productName: string;
  productCode: string;
  quantity: number;
  qtyReturned: number;
  unitPriceMinor: number;
};

type ReturnResult = { saleId: number; status: string; refundMinor: number };
type VoidResult = { saleId: number; status: string; reversedRevenueMinor: number };

type Props = {
  saleId: number;
  lines: ReturnableLine[];
  isOwner: boolean;
  alreadyVoided: boolean;
  returnAction: (key: string, input: unknown) => Promise<ActionResult<ReturnResult>>;
  voidAction: (key: string, input: unknown) => Promise<ActionResult<VoidResult>>;
};

export function ReturnForm({
  saleId,
  lines,
  isOwner,
  alreadyVoided,
  returnAction,
  voidAction,
}: Props) {
  const router = useRouter();
  // One key per screen instance; replaced after a successful reversal (D9).
  const returnKey = useRef<string>(crypto.randomUUID());
  const voidKey = useRef<string>(crypto.randomUUID());

  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const chosen = lines
    .map((l) => ({ line: l, quantity: quantities[l.saleLineId] ?? 0 }))
    .filter((c) => c.quantity > 0);

  const refundMinor = chosen.reduce(
    (sum, c) => sum + c.line.unitPriceMinor * c.quantity,
    0,
  );

  async function submitReturn() {
    setPending(true);
    setMessage(null);
    const result = await returnAction(returnKey.current, {
      saleId,
      lines: chosen.map((c) => ({ saleLineId: c.line.saleLineId, quantity: c.quantity })),
      reason,
    });
    setPending(false);

    if (result.ok) {
      returnKey.current = crypto.randomUUID();
      setQuantities({});
      setReason("");
      setMessage({
        tone: "ok",
        text: `Return recorded. Give the customer ${formatMinor(result.data.refundMinor)}.`,
      });
      router.refresh();
    } else {
      setMessage({ tone: "bad", text: result.message });
    }
  }

  async function submitVoid() {
    setPending(true);
    setMessage(null);
    const result = await voidAction(voidKey.current, { saleId, reason });
    setPending(false);

    if (result.ok) {
      voidKey.current = crypto.randomUUID();
      setReason("");
      setMessage({ tone: "ok", text: "Sale voided. Every unit has gone back to its batch." });
      router.refresh();
    } else {
      setMessage({ tone: "bad", text: result.message });
    }
  }

  if (alreadyVoided) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        This sale was voided. Nothing further can be returned against it.
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Return items</h2>

      <ul className="space-y-3">
        {lines.map((line) => {
          const returnable = line.quantity - line.qtyReturned;
          return (
            <li key={line.saleLineId} className="flex items-center justify-between gap-4">
              <div className="text-sm">
                <span className="font-medium">{line.productName}</span>
                <span className="text-muted-foreground block text-xs">
                  {line.productCode} · {formatMinor(line.unitPriceMinor)} each ·{" "}
                  {returnable} of {line.quantity} can still come back
                </span>
              </div>
              <Input
                aria-label={`Quantity to return for ${line.productName}`}
                type="number"
                min={0}
                max={returnable}
                disabled={returnable === 0}
                value={quantities[line.saleLineId] ?? 0}
                onChange={(e) =>
                  setQuantities((prev) => ({
                    ...prev,
                    [line.saleLineId]: Math.max(
                      0,
                      Math.min(returnable, Number(e.target.value)),
                    ),
                  }))
                }
                className="min-h-11 w-24 text-center"
              />
            </li>
          );
        })}
      </ul>

      <div className="space-y-1.5">
        <label htmlFor="reason" className="text-sm font-medium">
          Reason
        </label>
        {/* Required by the service AND by a database CHECK — this is the audit trail. */}
        <Input
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why are these coming back?"
          maxLength={200}
        />
      </div>

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

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={pending || chosen.length === 0 || reason.trim() === ""}
          onClick={() => void submitReturn()}
        >
          {pending ? "Recording…" : `Return · refund ${formatMinor(refundMinor)}`}
        </Button>

        {/*
          FR-022 — voiding is OWNER ONLY, and the button simply does not exist otherwise. The
          server enforces it regardless; hiding it here is courtesy, not security.
        */}
        {isOwner ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || reason.trim() === ""}
            onClick={() => void submitVoid()}
          >
            Void the whole sale
          </Button>
        ) : null}
      </div>

      {isOwner ? (
        <p className="text-muted-foreground text-xs">
          Voiding reverses every remaining unit at once. The sale is kept and marked voided —
          nothing is ever deleted.
        </p>
      ) : null}
    </div>
  );
}
