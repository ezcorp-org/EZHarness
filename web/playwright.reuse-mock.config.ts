/**
 * Focused cross-engine mock configuration.
 *
 * CI selects an engine explicitly from this config after its real-auth
 * lifecycle journey. It starts the built adapter server, so it reuses the
 * build already produced for that lifecycle instead of rebuilding the
 * application. This keeps both checks on the same production adapter server.
 * The default mock config remains Chromium-only for normal `test:e2e` runs.
 */
import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const browserProjects = {
	chromium: { browserName: "chromium" as const },
	firefox: { browserName: "firefox" as const },
	webkit: { browserName: "webkit" as const },
};

const requestedBrowserProjects = (process.env.PI_E2E_REUSE_BROWSER_PROJECTS ?? "firefox,webkit")
	.split(",")
	.map((project) => project.trim())
	.filter(Boolean);

if (
	requestedBrowserProjects.length === 0 ||
	requestedBrowserProjects.some((project) => !(project in browserProjects))
) {
	throw new Error(
		`PI_E2E_REUSE_BROWSER_PROJECTS must contain only ${Object.keys(browserProjects).join(", ")}.`,
	);
}

const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
const baseURL = base.use!.baseURL!;
const port = new URL(baseURL).port;

export default defineConfig({
	...base,
	projects: requestedBrowserProjects.map((name) => ({
		name,
		use: browserProjects[name as keyof typeof browserProjects],
	})),
	webServer: {
		...server,
		command: `EZCORP_PREVIEW_APP_HOST=localhost PI_SKIP_INIT=1 PORT=${port} HOST=127.0.0.1 ORIGIN=${baseURL} bun build/index.js`,
		cwd: __dirname,
	},
});
