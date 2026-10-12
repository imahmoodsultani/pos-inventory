import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

async function signInAsOwner(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(env.SEED_OWNER_EMAIL);
  await page.getByLabel("Password").fill(env.SEED_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

test.describe("catalogue", () => {
  test.skip(!env.SEED_OWNER_EMAIL, "seed credentials missing from .env.local");

  test("an owner creates a product through the real Server Action", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/inventory");

    // Unique per run so repeated runs do not collide on the unique code.
    const code = `E2E-${Date.now().toString().slice(-8)}`;

    await page.getByLabel("Code (SKU)").fill(code);
    await page.getByLabel("Name", { exact: true }).first().fill("E2E Widget");
    await page.getByLabel("Unit").selectOption("piece");
    await page.getByRole("button", { name: "Add product" }).click();

    await expect(page.getByRole("status")).toContainText("Product added", { timeout: 15_000 });
    // It must actually appear in the list, not merely report success.
    await expect(page.getByText(code)).toBeVisible();
  });

  test("a duplicate code is refused with a message that says why", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/inventory");

    const code = `DUP-${Date.now().toString().slice(-8)}`;
    // Submitted twice: the second must be refused.
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByLabel("Code (SKU)").fill(code);
      await page.getByLabel("Name", { exact: true }).first().fill("Duplicate Widget");
      await page.getByLabel("Unit").selectOption("piece");
      await page.getByRole("button", { name: "Add product" }).click();
      await page.waitForTimeout(1200);
    }

    // FR-044 — names the actual problem rather than "something went wrong".
    await expect(page.getByRole("alert").first()).toContainText(/already in use/i);
  });

  test("a salesperson cannot reach the catalogue", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(env.SEED_SALESPERSON_EMAIL);
    await page.getByLabel("Password").fill(env.SEED_SALESPERSON_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

    const response = await page.goto("/inventory");
    expect(response?.status()).not.toBe(200);
  });
});
