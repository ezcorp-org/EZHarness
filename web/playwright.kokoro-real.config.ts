/** Explicit external-model browser lane for the Kokoro ONNX integration. */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
	...base,
	testDir: "./e2e",
	testMatch: "kokoro-tts-realmodel.spec.ts",
	testIgnore: [],
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	fullyParallel: false,
	workers: 1,
	timeout: 600_000,
	retries: 0,
	reporter: process.env.CI ? "list" : "html",
});
