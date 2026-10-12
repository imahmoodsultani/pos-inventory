"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, parseMinor } from "@/lib/format";
import type { ActionResult } from "@/lib/types/action-result";

type Option = { id: number; label: string };

type Props = {
  products: Option[];
  vendors: Option[];
  grades: Option[];
  retainedProceedsMinor: number;
  action: (
    idempotencyKey: string,
    input: unknown,
  ) => Promise<ActionResult<{ batchId: number; totalCostMinor: number }>>;
};

type State = ActionResult<{ batchId: number; totalCostMinor: number }> | null;

export function ReceivingForm({
  products,
  vendors,
  grades,
  retainedProceedsMinor,
  action,
}: Props) {
  /**
   * ONE key for the lifetime of this form instance (D9).
   *
   * Generated in a ref initialiser so it survives every re-render — and re-rendering is constant
   * here, since the funding difference recomputes on each keystroke. Generating it per submit
   * would defeat the entire mechanism: a double-tap or a network retry would carry two different
   * keys and record two receipts.
   *
   * It is reset only after a SUCCESSFUL submit, when the next receipt is genuinely a new one.
   */
  const keyRef = useRef<string>(crypto.randomUUID());

  const [goodsCost, setGoodsCost] = useState("");
  const [landedCost, setLandedCost] = useState("");
  const [newCapital, setNewCapital] = useState("");
  const [reinvested, setReinvested] = useState("");

  const goodsMinor = parseMinor(goodsCost) ?? 0;
  const landedMinor = parseMinor(landedCost) ?? 0;
  const newCapitalMinor = parseMinor(newCapital) ?? 0;
  const reinvestedMinor = parseMinor(reinvested) ?? 0;

  const totalCostMinor = goodsMinor + landedMinor;
  const fundedMinor = newCapitalMinor + reinvestedMinor;
  const differenceMinor = fundedMinor - totalCostMinor;

  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_previous, formData) => {
      const result = await action(keyRef.current, {
        productId: Number(formData.get("productId")),
        vendorId: Number(formData.get("vendorId")),
        gradeId: Number(formData.get("gradeId")),
        qtyReceived: Number(formData.get("qtyReceived")),
        goodsCostMinor: parseMinor(String(formData.get("goodsCost") ?? "")) ?? 0,
        landedCostMinor: parseMinor(String(formData.get("landedCost") ?? "")) ?? 0,
        receivedAt: String(formData.get("receivedAt") || new Date().toISOString()),
        reference: String(formData.get("reference") ?? "") || undefined,
        funding: {
          newCapitalMinor: parseMinor(String(formData.get("newCapital") ?? "")) ?? 0,
          reinvestedMinor: parseMinor(String(formData.get("reinvested") ?? "")) ?? 0,
        },
      });

      if (result.ok) {
        // A new receipt is a new operation and needs its own key.
        keyRef.current = crypto.randomUUID();
        setGoodsCost("");
        setLandedCost("");
        setNewCapital("");
        setReinvested("");
      }
      return result;
    },
    null,
  );

  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  const fundingHint = useMemo(() => {
    if (totalCostMinor === 0) return null;
    if (differenceMinor === 0) return { tone: "ok" as const, text: "Funding balances." };
    if (differenceMinor > 0) {
      return {
        tone: "warn" as const,
        text: `Over-funded by ${formatMinor(differenceMinor)} — reduce by that amount.`,
      };
    }
    return {
      tone: "warn" as const,
      text: `Short by ${formatMinor(-differenceMinor)} — new capital plus reinvested revenue must equal the total cost.`,
    };
  }, [differenceMinor, totalCostMinor]);

  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Product" htmlFor="productId" error={fieldErrors.productId}>
          <Select name="productId" options={products} />
        </Field>
        <Field label="Vendor" htmlFor="vendorId" error={fieldErrors.vendorId}>
          <Select name="vendorId" options={vendors} />
        </Field>
        <Field label="Quality grade" htmlFor="gradeId" error={fieldErrors.gradeId}>
          <Select name="gradeId" options={grades} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Quantity" htmlFor="qtyReceived" error={fieldErrors.qtyReceived}>
          <Input id="qtyReceived" name="qtyReceived" type="number" min={1} step={1} required />
        </Field>
        <Field label="Goods cost" htmlFor="goodsCost" error={fieldErrors.goodsCostMinor}>
          <Input
            id="goodsCost"
            name="goodsCost"
            inputMode="decimal"
            value={goodsCost}
            onChange={(e) => setGoodsCost(e.target.value)}
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Landed cost (freight, duty)" htmlFor="landedCost" error={fieldErrors.landedCostMinor}>
          <Input
            id="landedCost"
            name="landedCost"
            inputMode="decimal"
            value={landedCost}
            onChange={(e) => setLandedCost(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Received on" htmlFor="receivedAt" hint="May be backdated.">
          <Input
            id="receivedAt"
            name="receivedAt"
            type="datetime-local"
            defaultValue={new Date().toISOString().slice(0, 16)}
            required
          />
        </Field>
        <Field label="Vendor invoice reference" htmlFor="reference" error={fieldErrors.reference}>
          <Input id="reference" name="reference" maxLength={120} />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">How was this paid for?</legend>
        <p className="text-muted-foreground text-sm">
          Total cost <strong>{formatMinor(totalCostMinor)}</strong>. Reinvested revenue is capped
          at <strong>{formatMinor(retainedProceedsMinor)}</strong> — the sale proceeds you have
          not already withdrawn or put back into stock.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From new capital" htmlFor="newCapital" error={fieldErrors.newCapitalMinor}>
            <Input
              id="newCapital"
              name="newCapital"
              inputMode="decimal"
              value={newCapital}
              onChange={(e) => setNewCapital(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="From reinvested revenue" htmlFor="reinvested" error={fieldErrors.reinvestedMinor}>
            <Input
              id="reinvested"
              name="reinvested"
              inputMode="decimal"
              value={reinvested}
              onChange={(e) => setReinvested(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        </div>
        {fundingHint ? (
          <p
            className={
              fundingHint.tone === "ok"
                ? "text-sm text-green-700 dark:text-green-400"
                : "text-destructive text-sm"
            }
          >
            {fundingHint.text}
          </p>
        ) : null}
      </fieldset>

      {state && !state.ok ? (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
          {state.correlationId ? ` (ref ${state.correlationId})` : null}
        </p>
      ) : null}

      {state?.ok ? (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Batch #{state.data.batchId} recorded at a total cost of{" "}
          {formatMinor(state.data.totalCostMinor)}.
        </p>
      ) : null}

      <Button
        type="submit"
        // Blocked client-side for a fast answer; the server re-checks and is the real authority.
        disabled={pending || totalCostMinor === 0 || differenceMinor !== 0}
      >
        {pending ? "Recording…" : "Record receipt"}
      </Button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {/* Associated with its control — an unlabelled input is announced as nothing at all. */}
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error?.length ? <p className="text-destructive text-xs">{error.join(". ")}</p> : null}
    </div>
  );
}

function Select({ name, options }: { name: string; options: Option[] }) {
  return (
    <select
      id={name}
      name={name}
      required
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
    >
      <option value="">Choose…</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
