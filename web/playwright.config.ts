import { defineConfig, devices } from "@playwright/test";

const isDocker = !!process.env.DOCKER_TEST;
const baseURL = isDocker ? "http://localhost:3000" : "http://localhost:4173";

// Visual-evidence mode (opt-in via `EZCORP_E2E_EVIDENCE=1`). When set, the
// `captureEvidence` helper owns screenshotting and attaches PNGs to each
// `@evidence`-tagged test, so Playwright's own `screenshot` is turned OFF
// (avoid double-capture) and the `blob` reporter is enabled so the captured
// attachments are collected into `web/blob-report/`. Video is a further
// opt-in (`EZCORP_E2E_EVIDENCE_VIDEO=1`). Outside evidence mode every key
// below is unchanged, so the no-flag `e2e-mock` job stays byte-identical.
const evidence = process.env.EZCORP_E2E_EVIDENCE === "1";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	// retries: 0 even in CI — a retry that turns a red test green hides a real
	// failure (or flake), which makes "all green" untrustworthy. The blocking
	// e2e gate must fail on the first failure. Genuinely-flaky specs belong in
	// a separate, NON-blocking lane (tag + own job) with an owner + tracking
	// issue — never papered over with a retry here. See
	// docs/development-lifecycle.md → "Trustworthy green".
	retries: 0,
	workers: process.env.CI ? 4 : undefined,
	timeout: 30_000,
	reporter: evidence ? [["blob"], ["list"]] : process.env.CI ? "list" : "html",
	...(isDocker && { globalSetup: "./e2e/docker-auth-setup.ts" }),
	use: {
		baseURL,
		// Block service-worker registration in e2e. The app's SW (precache +
		// clients.claim) is exercised by its own unit tests; letting it activate
		// here adds nothing and destabilises `chrome-headless-shell` (SIGSEGV on
		// SW fetch interception in the CI headless binary — full Chrome is fine),
		// crashing unrelated specs. Standard test-isolation, not a workaround.
		serviceWorkers: "block",
		// retain-on-failure (not on-first-retry) since retries are now 0.
		trace: "retain-on-failure",
		// In evidence mode `captureEvidence` owns capture — turn Playwright's
		// own screenshot OFF to avoid a duplicate shot per failure.
		screenshot: evidence ? "off" : "only-on-failure",
		...(process.env.EZCORP_E2E_EVIDENCE_VIDEO === "1" && { video: "on" }),
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
