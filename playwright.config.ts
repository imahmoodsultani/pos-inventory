import { defineConfig, devices } from "@playwright/test";

/**
 * T007. The E2E suite exists to prove two things inspection cannot:
 *   1. stock on screen updates in the SAME response as the sale (updateTag, not revalidateTag);
 *   2. the "Failed to find Server Action" retry path works as a normal flow, not an edge case.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Guarantees sellable stock; the till test consumes units every run.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // MUST match BETTER_AUTH_URL exactly. Better Auth validates the request Origin against its
    // configured baseURL, so 127.0.0.1 here against localhost there is rejected as CSRF — the
    // sign-in silently fails and every test times out on a page that never navigates.
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      /**
       * The constitution requires the sales flow to be usable at <=1024px (FR-043).
       *
       * Chromium at exactly 1024x768 with touch enabled, NOT an iPad device descriptor: those
       * pull in WebKit, and the requirement here is about viewport width and tap targets, not
       * about a second rendering engine. Testing the actual constraint beats testing a proxy
       * for it that also needs a 200MB download.
       */
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: false,
      },
    },
  ],
  webServer: {
    // dotenv, so the server Playwright starts has the same database and secrets the
    // test credentials belong to.
    command: "npx dotenv -e .env.local -- npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
