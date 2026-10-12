import Link from "next/link";
import { Suspense } from "react";

import { listProducts, listQualityGrades, listVendors } from "@/lib/dal/queries";
import { requireOwner } from "@/lib/dal/session";

import { createProductAction, updateProductAction } from "./actions";
import { CatalogueForm } from "./catalogue-forms";
import { EditableEntityList } from "./editable-entity-list";
import { createQualityGradeAction, updateQualityGradeAction } from "../grades/actions";
import { createVendorAction, updateVendorAction } from "../vendors/actions";

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
        {/*
          FR-045 — editing in place, not deactivate-and-recreate. Renaming a vendor must keep one
          vendor: recreating would split their margin report across two rows for one supplier.
        */}
        <EditableEntityList
          title="Products"
          idField="productId"
          action={updateProductAction}
          emptyNote="None yet."
          // code and unitOfMeasure are absent: the code identifies the product to a scanner and
          // the unit is fixed at creation (FR-048), since every quantity ever recorded is counted
          // in it.
          fields={[
            { name: "name", label: "Name" },
            { name: "reorderLevel", label: "Reorder level", type: "number" },
          ]}
          rows={products.map((p) => ({
            id: p.id,
            primary: p.name,
            secondary: `${p.code} · ${p.unitOfMeasure}`,
            inactive: !p.isActive,
            values: { name: p.name, reorderLevel: p.reorderLevel },
          }))}
        />
        <EditableEntityList
          title="Vendors"
          idField="vendorId"
          action={updateVendorAction}
          emptyNote="None yet."
          fields={[
            { name: "name", label: "Name" },
            { name: "phone", label: "Phone", clearable: true },
            { name: "email", label: "Email", clearable: true },
            { name: "notes", label: "Notes", clearable: true },
          ]}
          rows={vendors.map((v) => ({
            id: v.id,
            primary: v.name,
            secondary: v.phone ?? "",
            inactive: !v.isActive,
            values: { name: v.name, phone: v.phone, email: v.email, notes: v.notes },
          }))}
        />
        <EditableEntityList
          title="Grades"
          idField="gradeId"
          action={updateQualityGradeAction}
          emptyNote="None yet."
          // `code` is absent for the same reason: it is what past sale lines were graded as, and
          // changing it would relabel history.
          fields={[
            { name: "label", label: "Label" },
            { name: "sortOrder", label: "Sort order", type: "number" },
          ]}
          rows={grades.map((g) => ({
            id: g.id,
            primary: `${g.code} — ${g.label}`,
            secondary: "",
            inactive: !g.isActive,
            values: { label: g.label, sortOrder: g.sortOrder },
          }))}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        Correcting an entry updates it everywhere it is referenced, including past batches and
        sales — a renamed vendor stays one vendor. Entries are never deleted, since that would
        orphan the cost attribution on every batch and sale that references them. Deactivate
        instead: the entry disappears from new receipts and stays in all history.
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
