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

test.describe("physical stock count", () => {
  test.skip(!env.SEED_OWNER_EMAIL, "seed credentials missing from .env.local");

  /**
   * FR-049 — the count path end to end, through the real Server Action.
   *
   * The assertion that matters is the LAST one: after recording a shortfall the new figure must be
   * on screen in the same response. `updateTag` rather than `revalidateTag` is what makes that
   * true; with stale-while-revalidate the owner would be shown the pre-count number immediately
   * after disproving it.
   */
  test("recording a shortfall updates the expected figure in the same response", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await page.goto("/inventory/count");

    const firstRow = page.locator("li", { has: page.getByPlaceholder("count") }).first();
    test.skip(
      (await firstRow.count()) === 0,
      "no stock on hand to count — run the seed first",
    );

    const expectedText = await firstRow.getByText(/^expected \d+$/).innerText();
    const expected = Number(expectedText.replace(/\D/g, ""));
    test.skip(expected < 1, "batch is empty; nothing to find short");

    const counted = expected - 1;
    await firstRow.getByPlaceholder("count").fill(String(counted));

    // The delta is shown before anything is submitted, so the person at the shelf can see what
    // they are about to record rather than discovering it afterwards.
    await expect(firstRow.getByText("-1", { exact: true })).toBeVisible();

    // The reason is mandatory — the button stays disabled without it.
    await expect(page.getByRole("button", { name: /Record 1 adjustment/ })).toBeDisabled();
    await page.getByLabel(/Why\?/).fill("E2E physical count");

    await page.getByRole("button", { name: /Record 1 adjustment/ }).click();
    await expect(page.getByRole("status")).toContainText("Recorded 1 adjustment", {
      timeout: 15_000,
    });

    // The whole point: the figure on screen is now the counted one.
    await expect(firstRow.getByText(`expected ${counted}`)).toBeVisible({ timeout: 15_000 });
  });

  test("a count equal to the expected figure records nothing", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/inventory/count");

    const firstRow = page.locator("li", { has: page.getByPlaceholder("count") }).first();
    test.skip((await firstRow.count()) === 0, "no stock on hand to count");

    const expectedText = await firstRow.getByText(/^expected \d+$/).innerText();
    await firstRow.getByPlaceholder("count").fill(expectedText.replace(/\D/g, ""));
    await page.getByLabel(/Why\?/).fill("No change");

    // Counting fifty batches and finding nothing wrong must write nothing at all.
    await expect(page.getByRole("button", { name: "No differences to record" })).toBeDisabled();
  });

  test("a salesperson cannot reach the count screen", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(env.SEED_SALESPERSON_EMAIL);
    await page.getByLabel("Password").fill(env.SEED_SALESPERSON_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    const response = await page.goto("/inventory/count");
    expect(response?.status()).not.toBe(200);
  });
});
