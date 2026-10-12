import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getSaleDetail } from "@/lib/dal/reports";
import { requireOwner } from "@/lib/dal/session";
import { formatMinor } from "@/lib/format";

export const instant = false;

export default async function SaleDetailPage({
  params,
}: {
  params: Promise<{ saleId: string }>;
}) {
  await requireOwner();
  const { saleId } = await params;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 py-2">
      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading sale…</p>}>
        <Detail saleId={Number(saleId)} />
      </Suspense>
    </div>
  );
}

async function Detail({ saleId }: { saleId: number }) {
  if (!Number.isInteger(saleId) || saleId <= 0) notFound();
  const sale = await getSaleDetail({ saleId });
  if (!sale) notFound();

  const corrected = sale.lines.some((l) => l.batchCostCorrectedSince);

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sale {sale.saleNumber}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {sale.soldAt.toLocaleString()} · {sale.paymentMethod} ·{" "}
          <span className={sale.status === "voided" ? "text-destructive" : ""}>{sale.status}</span>
        </p>
        {sale.voidReason ? (
          <p className="text-destructive mt-1 text-sm">Voided: {sale.voidReason}</p>
        ) : null}
      </div>

      {/*
        FR-038. Every figure below is what was recorded AT THE TIME OF SALE. If the source batch
        has since been corrected, say so plainly — otherwise the owner compares this page with
        the batch page, sees two different unit costs, and has no way to tell which is wrong.
      */}
      {corrected ? (
        <p className="rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          The cost of at least one source batch has been corrected since this sale. The figures
          here are the ones recorded at the time and have deliberately not been restated.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Vendor at sale</th>
              <th className="px-3 py-2 font-medium">Grade at sale</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-right font-medium">Price each</th>
              <th className="px-3 py-2 text-right font-medium">Cost each</th>
              <th className="px-3 py-2 text-right font-medium">Profit</th>
            </tr>
          </thead>
          <tbody>
            {sale.lines.map((line) => (
              <tr key={line.saleLineId} className="border-t">
                <td className="px-3 py-2">
                  <span className="font-medium">{line.productName}</span>
                  <span className="text-muted-foreground block text-xs">{line.productCode}</span>
                </td>
                <td className="px-3 py-2">{line.vendorName}</td>
                <td className="px-3 py-2">{line.gradeCode}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {line.quantity}
                  {line.qtyReturned > 0 ? (
                    <span className="text-muted-foreground block text-xs">
                      {line.qtyReturned} returned
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMinor(line.unitPriceMinor)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMinor(line.unitCostMinorAtSale)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    line.profitMinor < 0 ? "text-destructive" : ""
                  }`}
                >
                  {formatMinor(line.profitMinor)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-muted/30 border-t">
            <tr>
              <td className="px-3 py-2 font-medium" colSpan={4}>Totals</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatMinor(sale.revenueMinor)}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatMinor(sale.costMinor)}
              </td>
              <td
                className={`px-3 py-2 text-right font-medium tabular-nums ${
                  sale.profitMinor < 0 ? "text-destructive" : ""
                }`}
              >
                {formatMinor(sale.profitMinor)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
