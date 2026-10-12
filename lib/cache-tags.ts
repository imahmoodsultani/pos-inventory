/**
 * Cache tag vocabulary.
 *
 * Centralised so a writer and a reader cannot drift apart on a string literal — a typo'd tag
 * fails silently by simply never invalidating anything, and the symptom is stale stock on a
 * till, long after the deploy that caused it.
 *
 * Always invalidated with `updateTag`, never `revalidateTag` (CLAUDE.md § Next.js 16).
 */

export const tags = {
  catalogue: "catalogue",
  stock: "stock",
  stockForProduct: (productId: number) => `stock:product:${productId}`,
  batch: (batchId: number) => `batch:${batchId}`,
  summary: "summary",
  cash: "cash",
} as const;
