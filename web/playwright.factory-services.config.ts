/**
 * The `factory-services` lane: browser journeys through the REAL factory
 * application (C11 lane 6, W14).
 *
 * `e2e/factory-services/stack.ts` boots every process the architecture names —
 * the product web server with its factory composition, the pool admission
 * service, the host supervisor with its Podman runner, Temporal behind mutual
 * TLS, and the Node orchestrator — over the shared PostgreSQL and object
 * storage, then HOLDS the stack and publishes its facts to a state file. The
 * journeys drive the console against it with a real session. Nothing in this
 * lane is mocked; a missing service fails readiness instead of passing empty.
 *
 * `FACTORY_SERVICES_EXTERNAL=1` attaches to a stack a caller already holds
 * (its state file named by `FACTORY_SERVICES_STATE`), which is how a local
 * proof runs the stack under the shared heavy-producer lock.
 */
import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedWebServer } from "./playwright-lane-bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lanes = JSON.parse(readFileSync(join(__dirname, "e2e", "lanes.json"), "utf8")) as { lanes: Record<string, string[]> };
const evidence = process.env.EZCORP_E2E_EVIDENCE === "1";
const external = process.env.FACTORY_SERVICES_EXTERNAL === "1";
const port = process.env.FACTORY_SERVICES_PORT ?? "4191";
const statePath = process.env.FACTORY_SERVICES_STATE ?? join(__dirname, "e2e", ".factory-services-state.json");
const baseURL = external && existsSync(statePath)
	? (JSON.parse(readFileSync(statePath, "utf8")) as { baseURL: string }).baseURL
	: `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: lanes.lanes["factory-services"].map(path => new RegExp(`${path.slice("web/".length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	timeout: 300_000,
	expect: { timeout: 30_000 },
	reporter: evidence ? [["blob"], ["list"]] : "list",
	globalSetup: "./e2e/factory-services/global-setup.ts",
	use: {
		baseURL,
		storageState: "./e2e/.factory-services-auth.json",
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
		screenshot: evidence ? "off" : "only-on-failure",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium", channel: "chromium" } }],
	webServer: external ? undefined : pinnedWebServer({
		command: "bun e2e/factory-services/stack.ts",
		cwd: __dirname,
		// No `url`: Playwright RACES a `url` check against `wait`, and /api/ready
		// answers while the stack is still setting up the administrator, the
		// projects, and the guest release. Only the "held" line, printed after
		// the state file is written, may release the global setup.
		wait: { stdout: /\[factory-services\] held/ },
		stdout: "pipe",
		timeout: 1_200_000,
		reuseExistingServer: false,
		gracefulShutdown: { signal: "SIGTERM", timeout: 120_000 },
		env: { FACTORY_SERVICES_PORT: port, FACTORY_SERVICES_STATE: statePath },
	}),
});
