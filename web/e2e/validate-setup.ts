/**
 * Playwright global setup: authenticate once and save storage state.
 * Used by playwright.validate.config.ts to avoid per-test login rate limiting.
 */
import { chromium } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";

export default async function globalSetup() {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();

	// Login via the API endpoint
	const response = await page.request.post(`${BASE}/api/auth/login`, {
		data: { email: "admin@ez-dev.local", password: "DevAdmin123" },
		headers: { "Content-Type": "application/json" },
	});

	if (!response.ok()) {
		const body = await response.text().catch(() => "");
		throw new Error(`Login failed ${response.status()}: ${body}`);
	}

	// Save auth state including cookies
	const storageState = path.resolve(__dirname, ".validate-auth.json");
	await context.storageState({ path: storageState });
	console.log(`[validate-setup] Auth state saved to ${storageState}`);

	await browser.close();
}
