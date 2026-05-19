/**
 * Blur-in loading for chat images. Pairs with the `.progressive-img*`
 * CSS in `app.css`: an `<img class="progressive-img">` inside a
 * `.progressive-img-wrap` starts blurred + transparent over a shimmer
 * placeholder, then settles to sharp once the bitmap loads.
 *
 * Two entry points share one `wire()` core:
 *  - `attachProgressiveImages(root)` for the raw-HTML markdown path
 *    (mirrors `attachImageFallbacks` in image-error-handler.ts).
 *  - `progressiveImage` Svelte action for component-rendered <img>s.
 */

function wire(img: HTMLImageElement): void {
	if (img.getAttribute("data-prog-wired")) return;
	img.setAttribute("data-prog-wired", "1");

	const wrap = img.closest<HTMLElement>(".progressive-img-wrap");

	const settle = (): void => {
		img.classList.add("progressive-img--loaded");
		wrap?.classList.add("progressive-img-wrap--loaded");
	};

	// Already cached/decoded (e.g. a re-render or back-nav): show it
	// immediately so we never play a fake blur over a ready image.
	if (img.complete && img.naturalWidth > 0) {
		settle();
		return;
	}

	img.addEventListener("load", settle, { once: true });
	img.addEventListener(
		"error",
		() => {
			// Stop the shimmer and structurally remove the wrapper so the
			// existing fallback / error UI lays out unchanged.
			img.classList.add("progressive-img--loaded");
			wrap?.classList.add(
				"progressive-img-wrap--loaded",
				"progressive-img-wrap--error",
			);
		},
		{ once: true },
	);
}

/** Wire every not-yet-wired progressive image inside `root`. */
export function attachProgressiveImages(root: HTMLElement): void {
	root
		.querySelectorAll<HTMLImageElement>(
			"img.progressive-img:not([data-prog-wired])",
		)
		.forEach(wire);
}

/** Svelte action: `<img class="progressive-img" use:progressiveImage>`. */
export function progressiveImage(node: HTMLImageElement) {
	wire(node);
	return {};
}
