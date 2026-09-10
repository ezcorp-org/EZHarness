import type { Locator } from "@playwright/test";
import { expect } from "./hydration.js";

/** Resolve a CSS theme token through the browser before comparing colors. */
export async function expectThemeColor(target: Locator, property: "color" | "background-color", token: string): Promise<void> {
	const expected = await target.evaluate((element, { property, token }) => {
		const probe = document.createElement("span");
		probe.style.setProperty(property, `var(${token})`);
		element.append(probe);
		const color = getComputedStyle(probe).getPropertyValue(property);
		probe.remove();
		return color;
	}, { property, token });
	await expect(target).toHaveCSS(property, expected);
}
