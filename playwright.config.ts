import { defineConfig, devices } from "@playwright/test";

/**
 * T007. The E2E suite exists to prove two things inspection cannot:
 *   1. stock on screen updates in the SAME response as the sale (updateTag, not revalidateTag);
 *   2. the "Failed to find Server Action" retry path works as a normal flow, not an edge case.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      // The constitution requires the sales flow to be usable at <=1024px.
      name: "tablet",
      use: { ...devices["iPad (gen 7) landscape"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
