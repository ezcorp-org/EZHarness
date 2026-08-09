import type { Locator, Page } from "@playwright/test";
// `expect` via the fixture root, never the package: a VALUE import of
// `@playwright/test` from a helper can resolve a SECOND copy and trip the
// "did not expect test.describe()" runtime guard (see picker-helpers.ts).
import { expect } from "./hydration.js";

/**
 * Readability assertions for the app's WARNING panels.
 *
 * ## Why this exists
 *
 * The codebase convention for a caution panel used to be `bg-amber-500/10` +
 * `text-amber-300`. That pairing was tuned on a dark surface and only works
 * there: `:root` in `web/src/app.css` is the LIGHT theme
 * (`--color-surface-secondary: #eef1f7`), so on the default theme those panels
 * rendered amber-300 (`#fdd271`) over a near-white tint — a contrast ratio
 * around 1.4:1, i.e. very nearly invisible. The panels it hit were the ones
 * that matter most: a per-tool-call consent prompt's security note, a warning
 * that moving a card launches a tool-running agent with no human approval, a
 * degraded-search notice.
 *
 * The fix carries the WARNING signal in the border/background and takes
 * LEGIBILITY from the theme's own text tokens, which holds in both themes by
 * construction. A screenshot alone cannot prove that: a reviewer looking at a
 * PNG of a washed-out panel has to *notice*. So the e2e specs assert the
 * rendered contrast NUMERICALLY and capture the screenshot as the human-
 * readable half of the same claim.
 *
 * Deliberately colour-agnostic: nothing here hardcodes a token value, so a
 * future palette change that stays legible keeps passing, while any
 * regression back to accent-coloured prose on a pale tint fails.
 */

/** WCAG 2.1 AA for normal-size body text. */
export const AA_NORMAL_TEXT = 4.5;

/**
 * Force the LIGHT theme before the app boots.
 *
 * The bug only manifests on light surfaces, so a spec that happened to run
 * dark would assert nothing. `initTheme()` reads this key on load and
 * defaults to `system` without it — which would make the assertion depend on
 * the runner's OS/browser preference.
 */
export async function useLightTheme(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.localStorage.setItem("ezcorp-theme", "light");
	});
}

/**
 * Force the DARK theme before the app boots.
 *
 * The pair to {@link useLightTheme}, and it earns its place for the same
 * reason: a tint tuned on one surface is a regression waiting on the other.
 * Light is where the washed-out-warning bug lives, but a panel whose prose
 * colour is pinned to a light-theme token fails the other way round, and a
 * spec that only ever ran on the default theme would never see it.
 */
export async function useDarkTheme(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.localStorage.setItem("ezcorp-theme", "dark");
	});
}

interface Measured {
	/** Contrast ratio of the composited text colour against the composited
	 *  background behind it, 1..21. */
	ratio: number;
	/** `color` as computed by the browser, for failure messages. */
	color: string;
	/** The opaque colour actually behind the text, after compositing every
	 *  translucent layer up the ancestor chain. */
	background: string;
	/** True when `document.documentElement` carries `.dark`. */
	dark: boolean;
}

/**
 * Measure the real rendered contrast of an element's text.
 *
 * Both sides are composited, which is the whole point here: warning panels
 * are translucent tints (`/10`) over a theme surface, and the old prose
 * colour was itself sometimes translucent (`text-amber-300/80`). Comparing
 * the raw declared values would compare two colours neither of which is on
 * screen.
 */
export async function measureContrast(target: Locator): Promise<Measured> {
	return await target.evaluate((el: Element) => {
		// Compositing is done by CANVAS, not by parsing the computed string.
		// Tailwind 4 emits an opacity modifier as `oklab(L a b / .8)`, and a
		// regex that assumes `rgb(r, g, b, a)` reads those L/a/b numbers as
		// 0-255 channels — turning pale amber into near-black and reporting a
		// FALSE PASS on exactly the panel this fixture exists to police.
		// Painting the colour and reading the pixel back is agnostic to the
		// colour syntax and gets alpha blending from the browser itself.
		const mk = () => {
			const c = document.createElement("canvas");
			c.width = 1;
			c.height = 1;
			return c.getContext("2d", { willReadFrequently: true })!;
		};
		const paint = mk();
		const probe = mk();

		const px = (ctx: CanvasRenderingContext2D): [number, number, number, number] => {
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
		};
		/** Alpha of an arbitrary CSS colour string, via an isolated context. */
		const alphaOf = (col: string): number => {
			probe.clearRect(0, 0, 1, 1);
			probe.fillStyle = "rgba(0, 0, 0, 0)";
			probe.fillStyle = col;
			probe.fillRect(0, 0, 1, 1);
			return px(probe)[3];
		};
		const luminance = ([r, g, b]: [number, number, number]): number => {
			const lin = (v: number) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
		};
		const rgb = (c: [number, number, number, number]) =>
			`rgb(${c[0]}, ${c[1]}, ${c[2]})`;

		// Walk UP collecting every background layer, stopping at the first
		// fully-opaque one — everything above it is invisible.
		const layers: string[] = [];
		for (let node: Element | null = el; node; node = node.parentElement) {
			const bg = getComputedStyle(node).backgroundColor;
			const a = alphaOf(bg);
			if (a > 0) layers.push(bg);
			if (a >= 1) break;
		}

		// Base: the page's own background, or white when nothing sets one.
		paint.clearRect(0, 0, 1, 1);
		paint.fillStyle = "#ffffff";
		paint.fillRect(0, 0, 1, 1);
		const rootBg = getComputedStyle(document.documentElement).backgroundColor;
		if (alphaOf(rootBg) >= 1) {
			paint.fillStyle = rootBg;
			paint.fillRect(0, 0, 1, 1);
		}
		// ...then each layer, outermost first, exactly as the compositor does.
		for (let i = layers.length - 1; i >= 0; i--) {
			paint.fillStyle = layers[i]!;
			paint.fillRect(0, 0, 1, 1);
		}
		const base = px(paint);

		const rawColor = getComputedStyle(el).color;
		paint.fillStyle = rawColor;
		paint.fillRect(0, 0, 1, 1);
		const text = px(paint);

		const [lo, hi] = [
			luminance([text[0], text[1], text[2]]),
			luminance([base[0], base[1], base[2]]),
		].sort((a, b) => a - b) as [number, number];
		return {
			ratio: (hi + 0.05) / (lo + 0.05),
			color: rawColor,
			background: rgb(base),
			dark: document.documentElement.classList.contains("dark"),
		};
	});
}

/**
 * Assert an element's text is legible where it actually sits.
 *
 * `where` names the panel in the failure message — a bare "expected 1.4 to be
 * >= 4.5" would not tell the next person which panel regressed.
 */
export async function expectReadable(
	target: Locator,
	where: string,
	min: number = AA_NORMAL_TEXT,
): Promise<Measured> {
	const m = await measureContrast(target);
	expect(
		m.ratio,
		`${where}: text ${m.color} on ${m.background} is ${m.ratio.toFixed(2)}:1, ` +
			`below the ${min}:1 minimum — this is the washed-out-warning regression ` +
			`(see web/e2e/fixtures/readable.ts).`,
	).toBeGreaterThanOrEqual(min);
	return m;
}

/**
 * Assert the panel still LOOKS like a warning.
 *
 * Legibility alone is satisfiable by deleting the tint entirely, which would
 * turn a caution panel into ordinary body text — a different bug with the
 * same green test. So each spec pins both halves: readable prose AND a
 * non-transparent warning-tinted background behind it.
 */
export async function expectWarningTinted(target: Locator, where: string): Promise<void> {
	// Alpha via canvas, same reason as measureContrast: the declared value can
	// be any CSS Color 4 syntax and must not be regex-parsed.
	const tint = await target.evaluate((el: Element) => {
		const c = document.createElement("canvas");
		c.width = 1;
		c.height = 1;
		const ctx = c.getContext("2d", { willReadFrequently: true })!;
		const alphaOf = (col: string): number => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = "rgba(0, 0, 0, 0)";
			ctx.fillStyle = col;
			ctx.fillRect(0, 0, 1, 1);
			return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
		};
		const s = getComputedStyle(el);
		return { background: s.backgroundColor, alpha: alphaOf(s.backgroundColor) };
	});
	expect(
		tint.alpha,
		`${where}: warning tint was dropped entirely (background ${tint.background})`,
	).toBeGreaterThan(0);
}
