import { defineConfig } from "@playwright/test";

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
	],
	...(!isDocker && {
		webServer: {
			command: "PI_SKIP_INIT=1 bun run build && PI_SKIP_INIT=1 bun run preview",
			url: "http://localhost:4173",
			reuseExistingServer: !process.env.CI,
		},
	}),
});
