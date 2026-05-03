/**
 * Playwright config override for validation runs against the already-running
 * dev server on port 5173. Does NOT start a webServer.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	forbidOnly: false,
	retries: 0,
	workers: 1,
	timeout: 45_000,
	reporter: "line",
	// globalSetup: "./e2e/validate-setup.ts",  // skip — storage state pre-created manually
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
		screenshot: "on",
		storageState: "./e2e/.validate-auth.json",
	},
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
	],
	// No webServer block — we use the already-running dev server
});
