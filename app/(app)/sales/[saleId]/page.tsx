import { notFound } from "next/navigation";
import { Suspense } from "react";

import { db } from "@/lib/db";
import { verifySession } from "@/lib/dal/session";
import { computeSaleDetail } from "@/lib/dal/reports-query";
import { formatMinor } from "@/lib/format";

import { recordSaleReturnAction, recordSaleVoidAction } from "../../till/actions";
import { ReturnForm } from "./return-form";

export const instant = false;

/**
 * Returns and voids (T069).
 *
 * Reachable by a SALESPERSON as well as the owner (FR-021) — returns happen at the counter and
 * must not wait for the owner. Which means this page must show no cost or profit, so it uses
 * computeSaleDetail directly and renders only the price-side fields. The owner's cost view lives
 * at /reports/sales/[saleId].
 */
export default async function SalePage({
  params,
}: {
  params: Promise<{ saleId: string }>;
}) {
  const user = await verifySession();
  const { saleId } = await params;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-2">
      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading sale…</p>}>
        <SaleView saleId={Number(saleId)} isOwner={user.role === "owner"} />
      </Suspense>
    </div>
  );
}

async function SaleView({ saleId, isOwner }: { saleId: number; isOwner: boolean }) {
  if (!Number.isInteger(saleId) || saleId <= 0) notFound();
  const sale = await computeSaleDetail(db, saleId);
  if (!sale) notFound();

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sale {sale.saleNumber}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {sale.soldAt.toLocaleString()} · {sale.paymentMethod} ·{" "}
          <span className={sale.status === "voided" ? "text-destructive" : ""}>
            {sale.status.replace("_", " ")}
          </span>
          {" · "}
          {formatMinor(sale.revenueMinor)}
        </p>
      </div>

      <ReturnForm
        saleId={sale.saleId}
        isOwner={isOwner}
        alreadyVoided={sale.status === "voided"}
        returnAction={recordSaleReturnAction}
        voidAction={recordSaleVoidAction}
        /*
          Only price-side fields cross this boundary. costMinor and profitMinor exist on the
          server object and are deliberately not passed: a salesperson can reach this page, and
          anything handed to a client component travels in the RSC payload (SC-010).
        */
        lines={sale.lines.map((l) => ({
          saleLineId: l.saleLineId,
          productName: l.productName,
          productCode: l.productCode,
          quantity: l.quantity,
          qtyReturned: l.qtyReturned,
          unitPriceMinor: l.unitPriceMinor,
        }))}
      />

      {isOwner ? (
        <a href={`/reports/sales/${sale.saleId}`} className="inline-block text-sm underline">
          See full cost and profit attribution →
        </a>
      ) : null}
    </>
  );
}
