import { Suspense } from "react";

import { db } from "@/lib/db";
import type { Tx } from "@/lib/db";
import { requireOwner } from "@/lib/dal/session";
import { formatMinor } from "@/lib/format";
import { getEditHistory } from "@/lib/services/audit";
import { getCashOnHandMinor, listCapitalEvents } from "@/lib/services/capital";

import {
  correctCapitalEventAction,
  recordCapitalInjectionAction,
  recordWithdrawalAction,
} from "./actions";
import { CapitalHistory } from "./capital-history";
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
  const [cashOnHandMinor, rawEvents] = await Promise.all([
    db.transaction((tx) => getCashOnHandMinor(tx as Tx)),
    db.transaction((tx) => listCapitalEvents(tx as Tx)),
  ]);

  // Edit history per entry, so a corrected figure reads as corrected rather than as though it had
  // always been that value.
  const events = await Promise.all(
    rawEvents.map(async (e) => ({
      id: e.id,
      eventType: e.eventType,
      amountMinor: e.amountMinor,
      occurredAt: e.occurredAt.toISOString(),
      note: e.note,
      edits: (await getEditHistory(db, "capital_events", e.id)).map((h) => ({
        id: h.id,
        fieldName: h.fieldName,
        oldValue: h.oldValue,
        newValue: h.newValue,
        reason: h.reason,
        changedAt: h.changedAt.toISOString(),
      })),
    })),
  );

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
        <p className="text-muted-foreground text-sm">
          A corrected entry shows what it was before. Entries are never deleted — an entry made
          entirely in error is corrected and its reason kept.
        </p>
        <CapitalHistory events={events} correctAction={correctCapitalEventAction} />
      </section>
    </>
  );
}
