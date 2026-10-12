import Link from "next/link";
import { Suspense } from "react";

import { getLowStock, getStockOnHand } from "@/lib/dal/queries";
import { requireOwner } from "@/lib/dal/session";
import { formatMinor } from "@/lib/format";


/**
 * Per-user and gated: every read here depends on who is asking, so there is no static shell to
 * prerender. Caching is forbidden on transactional data (CLAUDE.md), and `instant = false` on
 * the layout does not cover a page's own session read during client-side navigation.
 */
export const instant = false;
export default async function StockPage() {
  await requireOwner();

  return (
    <div className="space-y-8 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Stock on hand</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every batch still holding units, with the vendor it came from, its quality, and what
          each unit actually cost.
        </p>
      </div>

      {/*
        Both reads are uncached and sit behind their own Suspense boundary, so the slower one
        never holds up the other. Caching either would show stock that has already been sold.
      */}
      <Suspense fallback={<Loading label="stock" />}>
        <StockTable />
      </Suspense>

      <Suspense fallback={<Loading label="low stock" />}>
        <LowStockList />
      </Suspense>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <p className="text-muted-foreground text-sm">Loading {label}…</p>;
}

async function StockTable() {
  const rows = await getStockOnHand();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6">
        <h2 className="font-medium">Nothing in stock yet</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Record a delivery and it will appear here as its own batch.
        </p>
        <Link href="/receiving" className="mt-3 inline-block text-sm underline">
          Receive stock →
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            <Th>Product</Th>
            <Th>Vendor</Th>
            <Th>Grade</Th>
            <Th className="text-right">Remaining</Th>
            <Th className="text-right">Unit cost</Th>
            <Th className="text-right">Batch total</Th>
            <Th>Received</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.batchId} className="border-t">
              <Td>
                <Link href={`/inventory/batches/${r.batchId}`} className="hover:underline">
                  <span className="font-medium">{r.productName}</span>
                  <span className="text-muted-foreground block text-xs">{r.productCode}</span>
                </Link>
              </Td>
              <Td>{r.vendorName}</Td>
              <Td>{r.gradeCode}</Td>
              <Td className="text-right tabular-nums">
                {r.qtyRemaining}
                <span className="text-muted-foreground"> / {r.qtyReceived}</span>
              </Td>
              <Td className="text-right tabular-nums">
                {formatMinor(r.unitCostFloorMinor)}
                {/*
                  A batch whose cost does not divide evenly has no single per-unit cost: some
                  units carry one more minor unit than others. Showing "+n" is honest about that
                  rather than rounding and quietly disagreeing with the batch total.
                */}
                {r.unitCostRemainderMinor > 0 ? (
                  <span
                    className="text-muted-foreground"
                    title={`${r.unitCostRemainderMinor} unit(s) cost one minor unit more`}
                  >
                    {" "}
                    +{r.unitCostRemainderMinor}
                  </span>
                ) : null}
              </Td>
              <Td className="text-right tabular-nums">
                {formatMinor(r.totalCostMinor)}
                {r.isCostCorrected ? (
                  <span className="text-muted-foreground block text-xs">corrected</span>
                ) : null}
              </Td>
              <Td className="text-muted-foreground whitespace-nowrap">
                {r.receivedAt.toLocaleDateString()}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function LowStockList() {
  const rows = await getLowStock();

  return (
    <section className="space-y-2">
      <h2 className="font-medium">Running low</h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing is at or below its reorder level. Products with no reorder level set are not
          tracked here — set one on a product to start watching it.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.productId} className="flex items-center justify-between px-4 py-2 text-sm">
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground"> · {r.code}</span>
              </span>
              <span className="tabular-nums">
                {r.onHand} left, reorder at {r.reorderLevel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
