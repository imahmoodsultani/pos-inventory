import Link from "next/link";
import { Suspense } from "react";

import { TillBasket } from "@/components/till/till-basket";
import { getStockAvailability } from "@/lib/dal/queries";
import { verifySession } from "@/lib/dal/session";

import { recordSaleAction } from "./actions";


/**
 * Per-user and gated: every read here depends on who is asking, so there is no static shell to
 * prerender. Caching is forbidden on transactional data (CLAUDE.md), and `instant = false` on
 * the layout does not cover a page's own session read during client-side navigation.
 */
export const instant = false;
export default async function TillPage() {
  await verifySession();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Till</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick the batch each item comes from, set the price, and take payment.
        </p>
      </div>

      {/* Uncached and behind Suspense — a cached stock list would offer units already sold. */}
      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading stock…</p>}>
        <Basket />
      </Suspense>
    </div>
  );
}

async function Basket() {
  const batches = await getStockAvailability();

  if (batches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6">
        <h2 className="font-medium">Nothing is in stock</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          There are no units available to sell. Stock has to be received before it can be sold.
        </p>
        <Link href="/receiving" className="mt-3 inline-block text-sm underline">
          Receive stock →
        </Link>
      </div>
    );
  }

  return (
    <TillBasket
      action={recordSaleAction}
      batches={batches.map((b) => ({
        batchId: b.batchId,
        productId: b.productId,
        productCode: b.productCode,
        productName: b.productName,
        vendorName: b.vendorName,
        gradeCode: b.gradeCode,
        qtyRemaining: b.qtyRemaining,
        // Serialised for the client boundary; no cost field exists on this shape at all.
        receivedAt: b.receivedAt.toISOString(),
      }))}
    />
  );
}
