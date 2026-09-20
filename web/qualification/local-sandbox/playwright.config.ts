import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import real from "../../playwright.real.config";

if (!process.env.EZHARNESS_LOCAL_SANDBOX_CONFIG) throw new Error("Set EZHARNESS_LOCAL_SANDBOX_CONFIG to the private qualified host configuration");
const web = resolve(import.meta.dirname, "../..");
export default defineConfig({
  ...real,
  testDir: import.meta.dirname,
  testMatch: "local-mvp.pw.ts",
  timeout: 900_000,
  globalSetup: resolve(web, "e2e/real-auth-setup.ts"),
  globalTeardown: resolve(web, "e2e/real-auth-teardown.ts"),
  use: { ...real.use, storageState: resolve(web, "e2e/.real-auth.json") },
  reporter: [["list"]],
});
