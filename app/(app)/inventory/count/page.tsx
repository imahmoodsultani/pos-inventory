import Link from "next/link";
import { Suspense } from "react";

import { getStockOnHand } from "@/lib/dal/queries";
import { requireOwner } from "@/lib/dal/session";

import { recordStockCountAction } from "../../receiving/actions";
import { CountForm } from "./count-form";

export const instant = false;

/**
 * Physical stock count (FR-049).
 *
 * The one place where the recorded figure yields to reality. Everywhere else the system is the
 * authority on how much stock exists; here the shelf is, and the difference is written as
 * adjustment movements with the same per-unit cost the sale path would have used — so a shrinkage
 * costs exactly what selling those units would have.
 */
export default async function StockCountPage() {
  await requireOwner();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Physical count</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter what you actually counted on the shelf. Anything that differs from the expected
          figure is written as an adjustment — the recorded quantity is never silently overwritten.
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading stock…</p>}>
        <Count />
      </Suspense>

      <p className="text-muted-foreground text-xs">
        Adjustments appear in each batch&rsquo;s movement history and in the summary as shrinkage.
        See <Link href="/inventory/stock" className="underline">stock on hand</Link>.
      </p>
    </div>
  );
}

async function Count() {
  const stock = await getStockOnHand();

  return (
    <CountForm
      action={recordStockCountAction}
      // Depleted batches are omitted: a batch at zero has nothing on the shelf to count, and
      // listing every batch ever received would bury the ones that do.
      batches={stock
        .filter((b) => b.qtyRemaining > 0)
        .map((b) => ({
          batchId: b.batchId,
          productName: b.productName,
          productCode: b.productCode,
          vendorName: b.vendorName,
          gradeCode: b.gradeCode,
          qtyRemaining: b.qtyRemaining,
          qtyReceived: b.qtyReceived,
        }))}
    />
  );
}
