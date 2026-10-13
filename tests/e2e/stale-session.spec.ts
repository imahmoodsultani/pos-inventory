import { Pool } from "pg";
import { expect, test } from "@playwright/test";

import { readEnvLocal } from "./env";

const env = readEnvLocal();

/**
 * The stale session cookie: a cookie that exists but no longer maps to a live session.
 *
 * This is not an edge case. It is what every expiry leaves behind, and `updateStaffDetails` and
 * `resetUserPassword` create it ON PURPOSE (FR-047) — an owner correcting their own email signs
 * themselves out and lands here immediately.
 *
 * `proxy.ts` checks only that a cookie EXISTS, so the holder of a stale one reaches the page. The
 * page's session read is where the absence is discovered, and it must redirect rather than throw:
 * the layout's own redirect cannot save it, because layouts and pages render concurrently.
 */
test.describe("stale session cookie", () => {
  test.skip(!env.SEED_SALESPERSON_EMAIL, "seed credentials missing from .env.local");

  test("a cookie whose session is gone redirects to sign-in, it does not error", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(env.SEED_SALESPERSON_EMAIL);
    await page.getByLabel("Password").fill(env.SEED_SALESPERSON_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    // Revoke server-side exactly as an email change or password reset does, leaving the browser
    // holding a cookie that no longer resolves.
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)",
        [env.SEED_SALESPERSON_EMAIL],
      );
      expect(rowCount).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }

    const response = await page.goto("/");

    // The cookie is still in the jar — this is the stale-cookie path, not the no-cookie one.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name.includes("session"))).toBe(true);

    await expect(page).toHaveURL(/\/sign-in/);
    expect(response?.status()).toBeLessThan(400);
    // The specific regression: an unhandled UnauthenticatedError rendered as a server error.
    await expect(page.getByText(/No valid session|Application error|UNAUTHENTICATED/i)).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
