/**
 * BIGINT type parsing (T015).
 *
 * node-postgres returns BIGINT (OID 20) as a STRING by default, because a 64-bit integer does not
 * fit a JavaScript number. Every monetary column in this schema is BIGINT, so without this parser
 * `revenue_minor + cost_minor` silently becomes string concatenation: "1000" + "500" = "1000500".
 * That is a money bug that type-checks.
 *
 * We parse to number and THROW above Number.MAX_SAFE_INTEGER rather than returning an approximate
 * value. At 2^53 minor units the amounts involved are astronomically beyond a single-store retail
 * ledger, so the throw is a corruption alarm, not a limit anyone will hit legitimately.
 */

import pg from "pg";

const PG_BIGINT_OID = 20;

export function registerBigIntParser(): void {
  pg.types.setTypeParser(PG_BIGINT_OID, (value: string) => {
    if (value === null) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(
        `BIGINT ${value} from Postgres exceeds Number.MAX_SAFE_INTEGER and cannot be ` +
          `represented exactly. This indicates corrupt data or a unit error, not a large sale.`,
      );
    }
    return parsed;
  });
}
