/**
 * LOCAL-ONLY Playwright config — NOT committed.
 *
 * The shared config hardcodes port 4173 with `reuseExistingServer`, and a
 * second checkout of this repo runs its own preview server there; without a
 * private port a local run can silently measure the OTHER tree's build.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.EZ_LOCAL_E2E_PORT ?? 4183);
const evidence = process.env.EZCORP_E2E_EVIDENCE === "1";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	retries: 0,
	workers: 4,
	timeout: 30_000,
	reporter: evidence ? [["blob"], ["list"]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		serviceWorkers: "block",
		trace: "retain-on-failure",
		screenshot: evidence ? "off" : "only-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium" } }],
	webServer: {
		command: `PI_SKIP_INIT=1 bun run build && EZCORP_PREVIEW_APP_HOST=localhost PI_SKIP_INIT=1 bunx --bun vite preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		timeout: 300_000,
		reuseExistingServer: false,
	},
});
