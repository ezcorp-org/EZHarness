import type { Page } from "@playwright/test";
import { stringify } from "devalue";
import { expect } from "./hydration.js";
import { LAST_PATH_KEY } from "../../src/lib/resume-path.js";

type PageDataOptions = {
	/** Number of active route layouts before the page loader. Root + app is two. */
	layoutCount?: number;
};

/** Controlled loader data for route layouts and one page. */
export function pageDataResponse(data: Record<string, unknown>, { layoutCount = 2 }: PageDataOptions = {}) {
	return {
		type: "data",
		nodes: [...Array.from({ length: layoutCount }, () => null), { type: "data", data: JSON.parse(stringify(data)), uses: {} }],
	};
}

/** Mock only the loader response; SvelteKit still loads and renders the page. */
export async function mockPageData(page: Page, pathname: string, data: Record<string, unknown>, options?: PageDataOptions) {
	await page.route(`**${pathname}/__data.json**`, route => route.fulfill({ json: pageDataResponse(data, options) }));
}

/** The existing resume shell provides client navigation to a saved page. */
export async function resumePage(page: Page, pathname: string) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: LAST_PATH_KEY, value: pathname });
  await page.goto("/");
  await expect(page).toHaveURL(url => `${url.pathname}${url.search}${url.hash}` === pathname);
}
