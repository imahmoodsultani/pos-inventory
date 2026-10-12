import { Suspense } from "react";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { checkAllInvariants } from "@/lib/dal/invariants";
import { requireOwner } from "@/lib/dal/session";

export const instant = false;

type BatchRow = {
  id: number;
  productName: string;
  cached: number;
  derived: number;
};

/**
 * The reconciliation view (T101, FR-010).
 *
 * `batches.qty_remaining` is a denormalised cache. Constitution Principle II permits it ONLY
 * because it is reconstructible from the append-only movement ledger — and this page is where
 * that claim is shown rather than asserted: for every batch, the stored quantity beside the sum
 * of its movements.
 *
 * The same three invariants run nightly in cron. This page exists so the owner can check for
 * themselves, at any moment, without reading a log.
 */
export default async function ReconciliationPage() {
  await requireOwner();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reconciliation</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Proof that the quantities on screen match the movement history behind them.
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Checking…</p>}>
        <Checks />
      </Suspense>
    </div>
  );
}

async function Checks() {
  const [results, batchRows] = await Promise.all([
    checkAllInvariants(db),
    db.execute(sql`
      SELECT b.id,
             p.name AS "productName",
             b.qty_remaining AS cached,
             COALESCE(SUM(m.qty_delta), 0) AS derived
        FROM batches b
        JOIN products p ON p.id = b.product_id
        LEFT JOIN stock_movements m ON m.batch_id = b.id
       GROUP BY b.id, p.name, b.qty_remaining
       ORDER BY b.id DESC
       LIMIT 100
    `),
  ]);

  const batches = (
    Array.isArray(batchRows)
      ? batchRows
      : ((batchRows as unknown as { rows: unknown[] }).rows ?? [])
  ) as BatchRow[];

  const broken = results.filter((r) => !r.holds);

  return (
    <>
      <section className="space-y-2">
        {broken.length > 0 ? (
          <div role="alert" className="border-destructive bg-destructive/10 rounded-lg border p-4">
            <p className="font-medium">Something does not reconcile.</p>
            <p className="mt-1 text-sm">
              Treat the figures across the app as unreliable until this is resolved.
            </p>
          </div>
        ) : null}

        <ul className="divide-y rounded-lg border">
          {results.map((r) => (
            <li key={r.name} className="flex items-start justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{r.name}</p>
                <p className="text-muted-foreground text-xs">{r.detail}</p>
              </div>
              <span
                className={`text-sm font-medium ${
                  r.holds ? "text-green-700 dark:text-green-400" : "text-destructive"
                }`}
              >
                {r.holds ? "OK" : "FAILED"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Per batch (most recent 100)</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Batch</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Shown on screen</th>
                <th className="px-3 py-2 text-right font-medium">Sum of movements</th>
                <th className="px-3 py-2 text-right font-medium">Agree?</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const agrees = Number(b.cached) === Number(b.derived);
                return (
                  <tr key={b.id} className="border-t">
                    <td className="px-3 py-2 tabular-nums">#{b.id}</td>
                    <td className="px-3 py-2">{b.productName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(b.cached)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(b.derived)}</td>
                    <td
                      className={`px-3 py-2 text-right ${
                        agrees ? "text-green-700 dark:text-green-400" : "text-destructive"
                      }`}
                    >
                      {agrees ? "yes" : "NO"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
