import type { Page } from "@playwright/test";
import { expect } from "./hydration.js";

/** Select the visible scope and verify the request uses the active project. */
export async function selectMemoryScope(page: Page, scope: "all" | "project" | "global", projectId: string) {
	const labels = { all: "All", project: "This Project", global: "Org-wide" };
	const response = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === "/api/memories" && url.searchParams.get("scope") === scope;
	});
	await page.getByText("Scope:", { exact: true }).locator("..").getByRole("button", { name: labels[scope], exact: true }).click();
	const result = await response;
	expect(result.status()).toBe(200);
	expect(new URL(result.url()).searchParams.get("projectId")).toBe(projectId);
}
