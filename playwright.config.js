import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:8769/notification-test-site/",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://localhost:8769/notification-test-site/",
    reuseExistingServer: false,
  },
});
