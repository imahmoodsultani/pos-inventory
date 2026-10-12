import Link from "next/link";
import { Suspense } from "react";

import { db } from "@/lib/db";
import { listProducts, listQualityGrades, listVendors } from "@/lib/dal/queries";
import { getRetainedSaleProceedsMinor } from "@/lib/services/receiving";
import type { Tx } from "@/lib/db";
import { formatMinor } from "@/lib/format";
import { requireOwner } from "@/lib/dal/session";

import { receiveStockAction } from "./actions";
import { ReceivingForm } from "./receiving-form";


/**
 * Per-user and gated: every read here depends on who is asking, so there is no static shell to
 * prerender. Caching is forbidden on transactional data (CLAUDE.md), and `instant = false` on
 * the layout does not cover a page's own session read during client-side navigation.
 */
export const instant = false;
export default async function ReceivingPage() {
  await requireOwner();

  return (
    <div className="space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Receive stock</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Each delivery is recorded as its own batch. Its vendor, quality, and cost stay attached
          to those exact units until the last one is sold.
        </p>
      </div>

      {/* Uncached read behind Suspense — stock and cash are transactional (D4). */}
      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading catalogue…</p>}>
        <FormLoader />
      </Suspense>
    </div>
  );
}

async function FormLoader() {
  const [products, vendors, grades] = await Promise.all([
    listProducts(),
    listVendors(),
    listQualityGrades(),
  ]);

  const activeProducts = products.filter((p) => p.isActive);
  const activeVendors = vendors.filter((v) => v.isActive);
  const activeGrades = grades.filter((g) => g.isActive);

  // SC-008 — name the next action rather than showing an unusable form.
  if (activeProducts.length === 0 || activeVendors.length === 0 || activeGrades.length === 0) {
    const missing = [
      activeProducts.length === 0 ? "a product" : null,
      activeVendors.length === 0 ? "a vendor" : null,
      activeGrades.length === 0 ? "a quality grade" : null,
    ].filter(Boolean);

    return (
      <div className="rounded-lg border border-dashed p-6">
        <h2 className="font-medium">Before you can receive stock</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          You need {missing.join(" and ")} first — a batch has to know what arrived, who it came
          from, and at what quality.
        </p>
        <Link href="/inventory" className="mt-3 inline-block text-sm underline">
          Set up the catalogue →
        </Link>
      </div>
    );
  }

  // Read inside a transaction so the figure the owner sees is the figure the action will check.
  const retainedProceedsMinor = await db.transaction((tx) =>
    getRetainedSaleProceedsMinor(tx as Tx),
  );

  return (
    <>
      <ReceivingForm
        products={activeProducts.map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` }))}
        vendors={activeVendors.map((v) => ({ id: v.id, label: v.name }))}
        grades={activeGrades.map((g) => ({ id: g.id, label: `${g.code} — ${g.label}` }))}
        retainedProceedsMinor={retainedProceedsMinor}
        action={receiveStockAction}
      />
      <p className="text-muted-foreground text-xs">
        Reinvestable sale proceeds right now: {formatMinor(retainedProceedsMinor)}
      </p>
    </>
  );
}
