import { notFound } from "next/navigation";
import { Suspense } from "react";
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  batches,
  products,
  qualityGrades,
  stockMovements,
  vendors,
} from "@/lib/db/schema";
import { requireOwner } from "@/lib/dal/session";
import { displayUnitCost } from "@/lib/domain/allocation";
import { minor, type Minor } from "@/lib/domain/money";
import { formatMinor } from "@/lib/format";

import { addLandedCostAction, correctBatchCostAction } from "../../../receiving/actions";
import { CorrectionForm } from "./correction-form";

export const instant = false;

/** T094 — the owner-facing cost-correction screen for a single batch (FR-007, FR-007a). */
export default async function BatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  await requireOwner();
  const { batchId } = await params;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading batch…</p>}>
        <BatchView batchId={Number(batchId)} />
      </Suspense>
    </div>
  );
}

async function BatchView({ batchId }: { batchId: number }) {
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  const [batch] = await db
    .select({
      id: batches.id,
      productName: products.name,
      productCode: products.code,
      vendorName: vendors.name,
      gradeCode: qualityGrades.code,
      receivedAt: batches.receivedAt,
      qtyReceived: batches.qtyReceived,
      qtyRemaining: batches.qtyRemaining,
      goodsCostMinor: batches.goodsCostMinor,
      landedCostMinor: batches.landedCostMinor,
      totalCostMinor: batches.totalCostMinor,
      isCostCorrected: batches.isCostCorrected,
    })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .innerJoin(vendors, eq(vendors.id, batches.vendorId))
    .innerJoin(qualityGrades, eq(qualityGrades.id, batches.gradeId))
    .where(eq(batches.id, batchId))
    .limit(1);

  if (!batch) notFound();

  const movements = await db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.batchId, batchId))
    .orderBy(asc(stockMovements.id));

  const consumed = batch.qtyReceived - batch.qtyRemaining;
  const { unitCostFloorMinor, remainderMinor } = displayUnitCost(
    minor(batch.totalCostMinor) as Minor,
    batch.qtyReceived,
  );

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Batch #{batch.id} · {batch.productName}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {batch.vendorName} · grade {batch.gradeCode} · received{" "}
          {batch.receivedAt.toLocaleDateString()}
        </p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-4">
        <Stat label="Received" value={String(batch.qtyReceived)} />
        <Stat label="Remaining" value={String(batch.qtyRemaining)} />
        <Stat label="Total cost" value={formatMinor(batch.totalCostMinor)} />
        <Stat
          label="Unit cost"
          value={
            formatMinor(unitCostFloorMinor) + (remainderMinor > 0 ? ` +${remainderMinor}` : "")
          }
          note={
            remainderMinor > 0
              ? `${remainderMinor} unit(s) carry one minor unit more — the cost does not divide evenly`
              : undefined
          }
        />
      </dl>

      <CorrectionForm
        batchId={batch.id}
        goodsCostMinor={batch.goodsCostMinor}
        consumed={consumed}
        addLandedCost={addLandedCostAction}
        correctBatchCost={correctBatchCostAction}
      />

      <section className="space-y-2">
        <h2 className="font-medium">Full history</h2>
        <p className="text-muted-foreground text-sm">
          Append-only. Corrections appear as additional rows; nothing here is ever edited away.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {m.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">{m.movementType.replace("_", " ")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.qtyDelta === 0 ? "—" : m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinor(m.costMinor)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">{m.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {note ? <p className="text-muted-foreground mt-1 text-xs">{note}</p> : null}
    </div>
  );
}
