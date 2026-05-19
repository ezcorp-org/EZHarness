/**
 * Attach onerror fallbacks to every chat image inside `root`.
 * When an image fails to load (bad URL, expired, CSP block), the img is
 * swapped for an inline link to the original URL so the user can still
 * reach the source.
 */
export function attachImageFallbacks(root: HTMLElement): void {
	const imgs = root.querySelectorAll<HTMLImageElement>('img[data-chat-image="1"]:not([data-fallback-wired])');
	imgs.forEach((img) => {
		img.setAttribute("data-fallback-wired", "1");
		img.addEventListener("error", () => {
			const doc = img.ownerDocument ?? root.ownerDocument;
			if (!doc) return;
			const originalUrl = img.getAttribute("data-original-url") ?? img.getAttribute("src") ?? "";
			const alt = img.getAttribute("alt") ?? "";
			img.replaceWith(buildFallback(doc, originalUrl, alt));
		}, { once: true });
	});
}

function buildFallback(doc: Document, originalUrl: string, alt: string): HTMLElement {
	const container = doc.createElement("span");
	container.className = "chat-image-fallback";
	container.setAttribute("data-testid", "chat-image-fallback");

	const icon = doc.createElement("span");
	icon.className = "chat-image-fallback-icon";
	icon.setAttribute("aria-hidden", "true");
	icon.textContent = "🖼";

	const label = doc.createElement("span");
	label.className = "chat-image-fallback-label";
	label.textContent = alt ? `Image unavailable: ${alt}` : "Image unavailable";

	container.appendChild(icon);
	container.appendChild(label);

	if (originalUrl) {
		const link = doc.createElement("a");
		link.href = originalUrl;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.className = "chat-image-fallback-link";
		link.textContent = "Open original";
		container.appendChild(link);
	}

	return container;
}
