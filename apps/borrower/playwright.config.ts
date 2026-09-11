import { defineConfig, devices } from "@playwright/test";

// Chromium is preinstalled at /opt/pw-browsers (chromium-1194 = Playwright 1.56);
// never run `playwright install` here. `npm run test:e2e` sets PLAYWRIGHT_BROWSERS_PATH.
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`; // basePath is /app; tests navigate to /app?fixture=…

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    // Fixtures mode is a build-time flag (NEXT_PUBLIC_*), so the e2e run builds its own bundle,
    // then serves the standalone output exactly as Dockerfile.borrower does.
    command: `NEXT_PUBLIC_FIXTURES=1 npm run build && PORT=${port} HOSTNAME=127.0.0.1 node .next/standalone/server.js`,
    url: `${baseURL}/app`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
