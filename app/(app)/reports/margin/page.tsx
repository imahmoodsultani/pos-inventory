import { Suspense } from "react";

import { getMarginReport, type MarginGroupBy } from "@/lib/dal/reports";
import { requireOwner } from "@/lib/dal/session";

import { MarginTable } from "./margin-table";

export const instant = false;

const GROUPS: Array<{ value: MarginGroupBy; label: string }> = [
  { value: "vendor", label: "By vendor" },
  { value: "grade", label: "By quality grade" },
  { value: "product", label: "By product" },
];

export default async function MarginReportPage({
  searchParams,
}: {
  searchParams: Promise<{ groupBy?: string; from?: string; to?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const groupBy: MarginGroupBy = GROUPS.some((g) => g.value === params.groupBy)
    ? (params.groupBy as MarginGroupBy)
    : "vendor";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Margin report</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Which vendors, qualities and products actually earn — grouped on the vendor and grade
          recorded at the time of each sale, not on whatever the batch says today.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <div className="space-y-1.5">
          <label htmlFor="groupBy" className="text-sm font-medium">Group</label>
          <select
            id="groupBy"
            name="groupBy"
            defaultValue={groupBy}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            {GROUPS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="from" className="text-sm font-medium">From</label>
          <input id="from" name="from" type="date" defaultValue={params.from ?? ""}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="to" className="text-sm font-medium">To</label>
          <input id="to" name="to" type="date" defaultValue={params.to ?? ""}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm" />
        </div>
        <button type="submit" className="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm">
          Apply
        </button>
      </form>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading report…</p>}>
        <Report groupBy={groupBy} from={params.from} to={params.to} />
      </Suspense>
    </div>
  );
}

async function Report({
  groupBy,
  from,
  to,
}: {
  groupBy: MarginGroupBy;
  from?: string;
  to?: string;
}) {
  const rows = await getMarginReport({
    groupBy,
    from: from ? new Date(from) : null,
    to: to ? new Date(to) : null,
  });
  return <MarginTable rows={rows} />;
}
