import "server-only";

/**
 * The authenticated entry point to the business summary (T083).
 *
 * The arithmetic lives in ./summary-query.ts, which takes an executor and imports no pool. That
 * split exists because importing this module opens a connection: a pure query had no business
 * forcing DATABASE_URL to be set just to be unit-tested, and the nightly reconcile job needs the
 * same figures without a session.
 *
 * NOT cached. A stale summary is worse than a slow one — it is a number the owner will act on.
 */

import { db } from "@/lib/db";
import { requireOwner } from "@/lib/dal/session";
import { computeSummary, type BusinessSummary } from "./summary-query";

export type { BusinessSummary };

export async function getBusinessSummary(params?: {
  from?: Date | null;
  to?: Date | null;
}): Promise<BusinessSummary> {
  await requireOwner();
  return computeSummary(db, params);
}
