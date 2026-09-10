import { defineConfig } from "@playwright/test";
import realAuthConfig from "./playwright.real.config";

// The first-run journey must execute before real-auth globalSetup creates its
// admin. Reuse the real server's fresh PGlite directory and production boot
// command, but leave the database unseeded for the shipped /setup route.
// Playwright collects this explicit list in order: redirects first, then the
// only test that creates an account. The lane contract exercises that order.
export default defineConfig({
  ...realAuthConfig,
  testDir: "./e2e",
  testMatch: ["register-redirects.spec.ts", "setup-first-run.spec.ts"],
  // `undefined` is ignored by Playwright's config merge. An empty list is a
  // supported override that prevents real-auth from creating an admin first.
  globalSetup: [],
  use: { ...realAuthConfig.use, storageState: { cookies: [], origins: [] } },
});
