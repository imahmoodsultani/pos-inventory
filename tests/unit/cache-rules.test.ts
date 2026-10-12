import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T104 — the Cache Components rules, enforced rather than remembered.
 *
 * CLAUDE.md forbids `'use cache'` on anything transactional and reserves `'use cache: private'`
 * for session and identity reads. Both are easy to add later "just to speed this page up", and
 * the consequence — a cashier served stock numbers from before their own sale — is invisible in
 * review and intermittent in testing.
 *
 * A unit test rather than a convention, because conventions do not fail builds.
 */

const ROOTS = ["app", "lib", "components"];

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const sourceFiles = ROOTS.flatMap((r) => walk(path.resolve(process.cwd(), r)));

describe("Cache Components rules", () => {
  it("finds source files to check — otherwise this test proves nothing", () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("no plain 'use cache' anywhere in the app", () => {
    const offenders = sourceFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      // Matches the directive, not the words inside a comment explaining the ban.
      return /^\s*["']use cache["']\s*;?\s*$/m.test(text);
    });

    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      "stock, prices, cash and the summary are transactional; a cached read would show a " +
        "cashier data from before their own sale",
    ).toEqual([]);
  });

  it("'use cache: private' appears only on session or identity reads", () => {
    const offenders = sourceFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      if (!/^\s*["']use cache: private["']\s*;?\s*$/m.test(text)) return false;
      // Permitted only in the session/auth layer.
      const relative = path.relative(process.cwd(), file);
      return !(relative.includes("dal/session") || relative.includes("auth/"));
    });

    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it("no revalidateTag — updateTag only", () => {
    // Also blocked by ESLint; asserted here too so the rule surviving is not the only guarantee.
    const offenders = sourceFiles.filter((file) =>
      /\brevalidateTag\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      "revalidateTag is stale-while-revalidate: it would serve a cashier their pre-sale stock",
    ).toEqual([]);
  });

  it("no middleware.ts — the Next.js 16 convention is proxy.ts", () => {
    const stray = sourceFiles.filter((f) => path.basename(f) === "middleware.ts");
    expect(
      stray.map((f) => path.relative(process.cwd(), f)),
      "a middleware.ts in Next.js 16 silently never runs",
    ).toEqual([]);
  });
});
