import { defineConfig, devices } from "@playwright/test";

const isDocker = !!process.env.DOCKER_TEST;
const baseURL = isDocker ? "http://localhost:3000" : "http://localhost:4173";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 4 : undefined,
	timeout: 30_000,
	reporter: process.env.CI ? "list" : "html",
	...(isDocker && { globalSetup: "./e2e/docker-auth-setup.ts" }),
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		...(isDocker && { storageState: "./e2e/.docker-auth.json" }),
	},
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		// Phase 57 UX-04 (Plan 57-05) — touch-drag fixture target for
		// `chip-reorder.spec.ts`. Pixel 5 devices preset gives Playwright
		// the touchscreen + viewport metrics svelte-dnd-action's touch
		// handler exercises. Currently unused (all chip-reorder cases are
		// fixme pending auth + test-agent seed); kept here so future
		// un-fixme is one-line on the test side. Run via
		// `bunx playwright test --project=mobile-chromium`.
		{ name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
	],
	...(!isDocker && {
		webServer: {
			// EZCORP_PREVIEW_APP_HOST activates the secure-preview origin
			// dispatch for `*.preview.localhost` hosts (see
			// e2e/preview-static.spec.ts). Normal app requests (Host=localhost)
			// are unaffected — dispatch only fires for the preview subdomain
			// shape. The DB-free access-denied + bad-code paths are asserted in
			// plain preview; the full seeded handoff is Docker-gated.
			command:
				"PI_SKIP_INIT=1 bun run build && EZCORP_PREVIEW_APP_HOST=localhost PI_SKIP_INIT=1 bun run preview",
			url: "http://localhost:4173",
			// The command runs a full production `bun run build` before `preview`
			// can bind the port. On the constrained CI runner that build alone
			// exceeds Playwright's 60s default, so the webServer is reported as
			// timed-out before it is ever ready. Give build+preview real headroom
			// (this is server BOOT time, not a test retry — `retries` stays 0).
			timeout: 180_000,
			reuseExistingServer: !process.env.CI,
		},
	}),
});
