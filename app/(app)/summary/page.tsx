import { Suspense } from "react";

import { getBusinessSummary } from "@/lib/dal/summary";
import { requireOwner } from "@/lib/dal/session";
import { formatMinor } from "@/lib/format";

export const instant = false;

type SearchParams = Promise<{ from?: string; to?: string }>;

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireOwner();
  const params = await searchParams;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Business summary</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Where the money is, right now and over time.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <div className="space-y-1.5">
          <label htmlFor="from" className="text-sm font-medium">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={params.from ?? ""}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="to" className="text-sm font-medium">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={params.to ?? ""}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          />
        </div>
        <button
          type="submit"
          className="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm"
        >
          Apply
        </button>
        <a href="/summary" className="text-muted-foreground h-9 px-2 text-sm leading-9 underline">
          Clear
        </a>
      </form>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Calculating…</p>}>
        <Figures from={params.from} to={params.to} />
      </Suspense>
    </div>
  );
}

async function Figures({ from, to }: { from?: string; to?: string }) {
  const summary = await getBusinessSummary({
    from: from ? new Date(from) : null,
    to: to ? new Date(to) : null,
  });

  const ranged = Boolean(from || to);

  return (
    <div className="space-y-5">
      {/*
        T087 — a silent inconsistency is worse than an ugly banner. If the ledger stops
        balancing, the owner is making decisions on numbers that do not add up, and they must be
        told before they act on them rather than after.
      */}
      {!summary.identityHolds ? (
        <div
          role="alert"
          className="border-destructive bg-destructive/10 space-y-1 rounded-lg border p-4"
        >
          <p className="font-medium">These figures do not balance.</p>
          <p className="text-sm">
            The books are out by {formatMinor(Math.abs(summary.identityDifferenceMinor))}. Capital
            invested less recovered, plus profit, should equal cash plus inventory. Treat every
            number on this page as unreliable until this is investigated.
          </p>
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          {ranged ? "Activity in the selected period" : "Activity to date"}
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Trading profit"
            amountMinor={summary.profitToDateMinor}
            // FR-035a / T086 — named precisely, so it is never mistaken for net profit.
            note="Revenue less cost of goods sold. Rent, wages and other running costs are NOT included."
          />
          <Figure label="Capital invested" amountMinor={summary.capitalInvestedMinor} note="Money you put in." />
          <Figure
            label="Capital recovered"
            amountMinor={summary.capitalRecoveredMinor}
            note="Money you have taken back out."
          />
        </div>
      </section>

      <section className="space-y-2">
        {/*
          Labelled "current" even when a date range is applied, because they ARE current: a
          balance exists at an instant, not over a period. Showing a period's net cash movement
          under the heading "cash on hand" would be a different number wearing the same name.
        */}
        <h2 className="text-sm font-medium">
          Current position{ranged ? " — not affected by the date range" : ""}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Figure
            label="Cash on hand"
            amountMinor={summary.cashOnHandMinor}
            note="Cash from trading and capital events. Money spent outside the app is only reflected if recorded as a withdrawal."
          />
          <Figure
            label="Unsold inventory at cost"
            amountMinor={summary.inventoryAtCostMinor}
            note="What the stock still on your shelves cost you."
          />
        </div>
      </section>

      {summary.identityHolds ? (
        <p className="text-muted-foreground text-xs">
          Checks out: {formatMinor(summary.capitalInvestedMinor)} invested −{" "}
          {formatMinor(summary.capitalRecoveredMinor)} recovered +{" "}
          {formatMinor(summary.profitToDateMinor)} profit ={" "}
          {formatMinor(summary.cashOnHandMinor)} cash +{" "}
          {formatMinor(summary.inventoryAtCostMinor)} inventory.
        </p>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  amountMinor,
  note,
}: {
  label: string;
  amountMinor: number;
  note: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-sm">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          amountMinor < 0 ? "text-destructive" : ""
        }`}
      >
        {formatMinor(amountMinor)}
      </p>
      <p className="text-muted-foreground mt-2 text-xs">{note}</p>
    </div>
  );
}
