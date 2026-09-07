import { defineConfig } from "@playwright/test";
import freshSetupConfig from "./playwright.fresh-setup.config";

// Branch-only hosted diagnostic. It inherits the real preview command,
// empty first-run storage state, full Chromium channel, trace policy, and
// runner contract. The timeout is the only diagnostic-specific test setting.
export default defineConfig({
  ...freshSetupConfig,
  testDir: "./e2e/diagnostics",
  testMatch: "chromium-context-0733.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 1_200_000,
});
