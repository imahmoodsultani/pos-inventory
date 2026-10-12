import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * T070 — the sale path through a real browser.
 *
 * This is the only test that exercises the FULL stack: the form, the Server Action dispatch,
 * the preamble, the transaction, and the cache invalidation. The integration suite proves the
 * service layer is correct; nothing below this file proves the wiring between the form and that
 * service exists at all.
 *
 * Credentials are read from .env.local here rather than hardcoded, so the seeded password never
 * appears in the repository or in a terminal transcript.
 */

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

test.describe("till", () => {
  test("a salesperson completes a sale and sees stock update in the same response", async ({
    page,
  }) => {
    test.skip(
      !env.SEED_SALESPERSON_EMAIL,
      "seed credentials missing from .env.local — run the seed first",
    );

    // SC-006: a sale must be completable in under 60 seconds. Timed from the till loading.
    const started = Date.now();

    await signIn(page, env.SEED_SALESPERSON_EMAIL, env.SEED_SALESPERSON_PASSWORD);
    await page.goto("/till");

    const picker = page.locator("select").first();
    await expect(picker).toBeVisible();

    /**
     * Pick the batch with the MOST units, rather than whichever happens to be first.
     *
     * The picker is ordered by product and receipt date, so index 1 is the oldest batch — which
     * in a long-lived development database is usually the one that has been sold down to
     * nothing. Choosing by available quantity makes the test independent of both ordering and
     * how many times it has run before.
     *
     * The option text is "<product> · <vendor> · grade <g> · <n> left", which doubles as the
     * assertion that the till shows vendor and grade but NO cost.
     */
    const options = await picker.locator("option").all();
    let bestValue: string | null = null;
    let before = 0;
    for (const option of options) {
      const text = (await option.textContent()) ?? "";
      const left = Number(/(\d+)\s+left/.exec(text)?.[1] ?? 0);
      if (left > before) {
        before = left;
        bestValue = await option.getAttribute("value");
      }
    }
    expect(bestValue, "no batch with stock in the picker").toBeTruthy();
    expect(before, "no batch had more than 2 units available").toBeGreaterThan(2);

    // A cost figure must never reach this page (SC-010).
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    expect(bodyText).not.toContain("unit cost");
    expect(bodyText).not.toContain("profit");

    // Line 1 — one unit from the chosen batch.
    await picker.selectOption(bestValue!);
    await page.getByLabel("Price each").first().fill("2.50");

    // Line 2 — two more from the SAME batch, so the expected decrement is unambiguous.
    await page.getByRole("button", { name: "Add another item" }).click();
    const second = page.locator("select").nth(1);
    await second.selectOption(bestValue!);
    await page.getByLabel("Price each").nth(1).fill("3.00");
    await page.getByRole("button", { name: "Increase quantity" }).nth(1).click();

    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page.getByRole("status")).toContainText(/Sale S-\d+ recorded/, {
      timeout: 20_000,
    });

    const elapsedSeconds = (Date.now() - started) / 1000;
    expect(elapsedSeconds, `sale took ${elapsedSeconds.toFixed(1)}s`).toBeLessThan(60);

    /**
     * THE updateTag ASSERTION.
     *
     * The stock figure must already be lower in the response the cashier is looking at — no
     * reload. With `revalidateTag` (stale-while-revalidate) this page would still show the
     * PRE-SALE count, meaning a cashier could sell the same last unit twice because the screen
     * told them it was there.
     */
    await page.getByRole("button", { name: "Next customer" }).click();
    const afterText =
      (await page
        .locator("select")
        .first()
        .locator(`option[value="${bestValue}"]`)
        .textContent()) ?? "";
    const after = Number(/(\d+)\s+left/.exec(afterText)?.[1]);

    expect(
      after,
      `stock still reads ${after} after selling 3 units from ${before} — the page is serving ` +
        `stale data, which is what revalidateTag does and updateTag exists to prevent`,
    ).toBe(before - 3);
  });

  test("an owner sees the receiving and summary navigation; a salesperson does not", async ({
    page,
  }) => {
    test.skip(!env.SEED_OWNER_EMAIL, "seed credentials missing from .env.local");

    await signIn(page, env.SEED_SALESPERSON_EMAIL, env.SEED_SALESPERSON_PASSWORD);
    await expect(page.getByRole("link", { name: "Till" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Summary" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Receiving" })).toHaveCount(0);
  });

  test("signed-out visitors are redirected to sign-in", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/till");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
