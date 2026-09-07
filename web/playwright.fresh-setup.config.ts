import { defineConfig } from "@playwright/test";
import realAuthConfig from "./playwright.real.config";

// The first-run journey must execute before real-auth globalSetup creates its
// admin. Reuse the real server's fresh PGlite directory and production boot
// command, but leave the database unseeded for the shipped /setup route.
export default defineConfig({
  ...realAuthConfig,
  testDir: "./e2e",
  testMatch: "setup-first-run.spec.ts",
  // `undefined` is ignored by Playwright's config merge. An empty list is a
  // supported override that prevents real-auth from creating an admin first.
  globalSetup: [],
  use: { ...realAuthConfig.use, storageState: { cookies: [], origins: [] } },
});
