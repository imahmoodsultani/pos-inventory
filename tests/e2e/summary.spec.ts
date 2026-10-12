import { expect, test, type Page } from "@playwright/test";

import { readEnvLocal } from "./env";

const env = readEnvLocal();

async function signInAsOwner(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(env.SEED_OWNER_EMAIL);
  await page.getByLabel("Password").fill(env.SEED_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

test.describe("summary", () => {
  // Same guard shape as till.spec.ts: a plain boolean, evaluated once at collection.
  test.skip(!env.SEED_OWNER_EMAIL, "seed credentials missing from .env.local");

  test("shows every headline figure and states the identity balances", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/summary");

    for (const label of [
      "Trading profit",
      "Capital invested",
      "Capital recovered",
      "Cash on hand",
      "Unsold inventory at cost",
    ]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // FR-035a / T086 — profit must never be mistakable for net profit.
    await expect(page.getByText(/running costs are NOT included/i)).toBeVisible();

    // SC-003 surfaced to the owner, not merely assumed internally.
    await expect(page.getByText(/Checks out/)).toBeVisible();
    // Scoped to OUR banner by its text: a bare getByRole("alert") also matches the Next.js Dev
    // Tools element that is always present in development.
    await expect(page.getByText(/These figures do not balance/)).toHaveCount(0);
  });

  test("a date range leaves the position figures labelled as current (FR-034)", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await page.goto("/summary?from=2026-01-01&to=2026-02-01");
    await expect(page.getByText(/not affected by the date range/)).toBeVisible();
  });

  test("a salesperson cannot reach the summary at all", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(env.SEED_SALESPERSON_EMAIL);
    await page.getByLabel("Password").fill(env.SEED_SALESPERSON_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    const response = await page.goto("/summary");
    // requireOwner() throws ForbiddenError — the page must not render figures either way.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("Capital invested");
    expect(response?.status()).not.toBe(200);
  });
});
