import Link from "next/link";
import { Suspense } from "react";

import { listProducts, listQualityGrades, listVendors } from "@/lib/dal/queries";
import { requireOwner } from "@/lib/dal/session";

import { createProductAction } from "./actions";
import { CatalogueForm } from "./catalogue-forms";
import { createQualityGradeAction } from "../grades/actions";
import { createVendorAction } from "../vendors/actions";

export const instant = false;

/**
 * Catalogue management (T051).
 *
 * Everything a batch needs to exist: what the product is, who it came from, and at what quality.
 * The receiving form is unusable until all three exist, which is why this page leads the
 * first-run path (SC-008).
 */
export default async function CataloguePage() {
  await requireOwner();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Catalogue</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Products, vendors and quality grades. Every batch of stock is pinned to one of each,
          and those facts stay attached to its units for life.
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading catalogue…</p>}>
        <Catalogue />
      </Suspense>
    </div>
  );
}

async function Catalogue() {
  const [products, vendors, grades] = await Promise.all([
    listProducts(),
    listVendors(),
    listQualityGrades(),
  ]);

  const ready = products.length > 0 && vendors.length > 0 && grades.length > 0;

  return (
    <>
      {/*
        SC-008 — an untrained owner must reach their first recorded sale unaided. Rather than
        three empty tables, say exactly what is missing and what it unlocks.
      */}
      {!ready ? (
        <div className="rounded-lg border border-dashed p-5">
          <h2 className="font-medium">Set this up first</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            You need at least one of each before stock can be received:
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            <Step done={products.length > 0}>A product — what you sell</Step>
            <Step done={vendors.length > 0}>A vendor — who you buy it from</Step>
            <Step done={grades.length > 0}>A quality grade — e.g. A, B, C</Step>
          </ul>
          {ready ? null : (
            <p className="text-muted-foreground mt-3 text-sm">
              Then you can <Link href="/receiving" className="underline">receive stock</Link>.
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Everything is set up. <Link href="/receiving" className="underline">Receive stock →</Link>
        </p>
      )}

      <div className="grid gap-4">
        <CatalogueForm
          title="Product"
          description="A thing you sell. The code is what a scanner reads."
          action={createProductAction}
          submitLabel="Add product"
          fields={[
            { name: "code", label: "Code (SKU)", required: true },
            { name: "name", label: "Name", required: true },
            {
              name: "unitOfMeasure",
              label: "Unit",
              type: "select",
              required: true,
              // FR-001 — discrete countable units only. Weight and length are deliberately
              // absent: every quantity column is INTEGER, so half a kilo could be stored but
              // never transacted.
              options: [
                { value: "piece", label: "piece" },
                { value: "box", label: "box" },
                { value: "pack", label: "pack" },
                { value: "pair", label: "pair" },
              ],
            },
            {
              name: "reorderLevel",
              label: "Reorder level",
              type: "number",
              hint: "Leave at 0 to not track this product on the low-stock list.",
            },
          ]}
        />

        <CatalogueForm
          title="Vendor"
          description="Who you buy from. Names are unique regardless of capitalisation."
          action={createVendorAction}
          submitLabel="Add vendor"
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "phone", label: "Phone" },
            { name: "email", label: "Email" },
            { name: "notes", label: "Notes" },
          ]}
        />

        <CatalogueForm
          title="Quality grade"
          description="How you distinguish the same product arriving at different quality."
          action={createQualityGradeAction}
          submitLabel="Add grade"
          fields={[
            { name: "code", label: "Code", required: true, hint: "Short, e.g. A" },
            { name: "label", label: "Label", required: true, hint: "e.g. Premium" },
            {
              name: "sortOrder",
              label: "Sort order",
              type: "number",
              hint: "Controls the order grades appear in at the till.",
            },
          ]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <EntityList
          title="Products"
          items={products.map((p) => ({
            id: p.id,
            primary: p.name,
            secondary: `${p.code} · ${p.unitOfMeasure}`,
            inactive: !p.isActive,
          }))}
        />
        <EntityList
          title="Vendors"
          items={vendors.map((v) => ({
            id: v.id,
            primary: v.name,
            secondary: v.phone ?? "",
            inactive: !v.isActive,
          }))}
        />
        <EntityList
          title="Grades"
          items={grades.map((g) => ({
            id: g.id,
            primary: `${g.code} — ${g.label}`,
            secondary: "",
            inactive: !g.isActive,
          }))}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        Catalogue entries are never deleted — doing so would orphan the cost attribution on every
        batch and sale that references them. Deactivate instead: the entry disappears from new
        receipts and stays in all history.
      </p>
    </>
  );
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className={done ? "text-muted-foreground" : ""}>
      <span className={done ? "text-green-700 dark:text-green-400" : ""}>
        {done ? "✓" : "○"}
      </span>{" "}
      {children}
    </li>
  );
}

function EntityList({
  title,
  items,
}: {
  title: string;
  items: Array<{ id: number; primary: string; secondary: string; inactive: boolean }>;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
          None yet.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {items.map((item) => (
            <li key={item.id} className="px-3 py-2">
              <span className={item.inactive ? "text-muted-foreground line-through" : ""}>
                {item.primary}
              </span>
              {item.secondary ? (
                <span className="text-muted-foreground block text-xs">{item.secondary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
