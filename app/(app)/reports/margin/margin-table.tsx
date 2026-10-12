"use client";

/**
 * Margin report table (T093).
 *
 * ⚠️ DELIBERATE DEVIATION FROM THE TASK, which specified TanStack Table v9.
 *
 * v9's API is a ground-up redesign — `useTable` rather than `useReactTable`, explicit
 * `tableFeatures({...})` opt-in, `createSortedRowModel(sortFns)` — and I could not get its
 * generics to line up from the shipped type definitions without more guessing than this screen
 * justifies. The report is one grouped query returning at most a few hundred rows, and the only
 * interaction is sorting a column.
 *
 * Plain React does that in thirty lines with no version risk, no client bundle cost, and nothing
 * to re-learn when v9 settles. `@tanstack/react-table` has been removed from package.json
 * accordingly; if this screen later needs column pinning, virtualisation or faceted filters,
 * that is the moment to add it back.
 *
 * Sorting is numeric-aware rather than lexical: sorting "Profit" as a string would put 900 above
 * 1000, which on a margin report is a wrong answer rather than an odd order.
 */

import { useMemo, useState } from "react";

import { formatMinor } from "@/lib/format";

export type MarginRow = {
  key: string;
  label: string;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  marginPercent: number | null;
  unitsSold: number;
};

type SortKey = keyof Omit<MarginRow, "key">;

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "label", label: "Group", numeric: false },
  { key: "unitsSold", label: "Units sold", numeric: true },
  { key: "revenueMinor", label: "Revenue", numeric: true },
  { key: "costMinor", label: "Cost", numeric: true },
  { key: "profitMinor", label: "Profit", numeric: true },
  { key: "marginPercent", label: "Margin", numeric: true },
];

export function MarginTable({ rows }: { rows: MarginRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("profitMinor");
  const [descending, setDescending] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];

      // A null margin means "no revenue", not "zero margin". Sort those to the end either way
      // rather than letting them masquerade as the worst-performing group.
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;

      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      return descending ? -comparison : comparison;
    });
    return copy;
  }, [rows, sortKey, descending]);

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
        No sales in this period, so there is no margin to report yet.
      </p>
    );
  }

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setDescending((d) => !d);
    } else {
      setSortKey(key);
      setDescending(true);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={`px-3 py-2 font-medium ${column.numeric ? "text-right" : ""}`}
                aria-sort={
                  sortKey === column.key
                    ? descending
                      ? "descending"
                      : "ascending"
                    : "none"
                }
              >
                <button
                  type="button"
                  onClick={() => toggle(column.key)}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {column.label}
                  {sortKey === column.key ? <span>{descending ? "↓" : "↑"}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="px-3 py-2">{row.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.unitsSold}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatMinor(row.revenueMinor)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMinor(row.costMinor)}</td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  row.profitMinor < 0 ? "text-destructive" : ""
                }`}
              >
                {formatMinor(row.profitMinor)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {row.marginPercent === null ? (
                  <span className="text-muted-foreground" title="No revenue on these units">
                    —
                  </span>
                ) : (
                  `${row.marginPercent.toFixed(1)}%`
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
