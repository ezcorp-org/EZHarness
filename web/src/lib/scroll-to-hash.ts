/**
 * Smooth-scroll to the element targeted by `location.hash` once a
 * settings sub-page has finished loading. Mirrors the old mega-page
 * behavior (100ms defer so the section has rendered). No-op without a
 * hash, outside the browser, or when the anchor doesn't exist.
 */
export function scrollToLocationHash(delay = 100): void {
	if (typeof window === "undefined") return;
	const hash = window.location.hash;
	if (!hash || hash === "#") return;
	setTimeout(() => {
		try {
			document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" });
		} catch {
			/* invalid selector in hash — ignore */
		}
	}, delay);
}
