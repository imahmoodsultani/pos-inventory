import { Suspense } from "react";

import { db } from "@/lib/db";
import type { Tx } from "@/lib/db";
import { requireOwner } from "@/lib/dal/session";
import { formatMinor } from "@/lib/format";
import { getCashOnHandMinor, listCapitalEvents } from "@/lib/services/capital";

import { recordCapitalInjectionAction, recordWithdrawalAction } from "./actions";
import { CapitalForm } from "./capital-forms";

export const instant = false;

export default async function CapitalPage() {
  await requireOwner();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Capital and cash</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Money you put into the business, and money you take back out.
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading…</p>}>
        <CapitalPanels />
      </Suspense>
    </div>
  );
}

async function CapitalPanels() {
  const [cashOnHandMinor, events] = await Promise.all([
    db.transaction((tx) => getCashOnHandMinor(tx as Tx)),
    db.transaction((tx) => listCapitalEvents(tx as Tx)),
  ]);

  return (
    <>
      <div className="rounded-lg border p-4">
        <p className="text-muted-foreground text-sm">Cash on hand</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {formatMinor(cashOnHandMinor)}
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          Derived from every capital, sale, purchase and refund event — never stored as a running
          total that could drift.
        </p>
      </div>

      <div className="grid gap-4">
        <CapitalForm
          kind="injection"
          action={recordCapitalInjectionAction}
          cashOnHandMinor={cashOnHandMinor}
        />
        <CapitalForm
          kind="withdrawal"
          action={recordWithdrawalAction}
          cashOnHandMinor={cashOnHandMinor}
        />
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">History</h2>
        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing recorded yet. Put money in above to get started.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {events.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-4 px-4 py-2">
                <span className="text-sm">
                  <span className="font-medium capitalize">{e.eventType}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {e.occurredAt.toLocaleDateString()}
                  </span>
                  {e.note ? (
                    <span className="text-muted-foreground block text-xs">{e.note}</span>
                  ) : null}
                </span>
                <span
                  className={`tabular-nums ${
                    e.eventType === "withdrawal" ? "text-destructive" : ""
                  }`}
                >
                  {e.eventType === "withdrawal" ? "−" : "+"}
                  {formatMinor(e.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
