/**
 * `use:hoverTooltip={"full text"}` — shows a fixed-positioned tooltip on
 * mouseenter/focus. Escapes clipping ancestors via position:fixed and clamps
 * to the viewport. Only renders when the tooltip text is non-empty.
 */
export function hoverTooltip(node: HTMLElement, text: string | null | undefined) {
	let tip: HTMLDivElement | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let current = text ?? "";

	const MARGIN = 8;
	const GAP = 8;
	const DELAY = 150;

	function isTruncated(): boolean {
		// Horizontal overflow → text is clipped by ellipsis or hidden.
		return node.scrollWidth > node.clientWidth + 1;
	}

	function show() {
		if (!current) return;
		if (!isTruncated()) return;
		const rect = node.getBoundingClientRect();
		tip = document.createElement("div");
		tip.setAttribute("role", "tooltip");
		tip.textContent = current;
		tip.style.cssText = [
			"position:fixed",
			"z-index:1000",
			"max-width:320px",
			"padding:4px 8px",
			"font-size:12px",
			"line-height:1.4",
			"border-radius:6px",
			"border:1px solid var(--color-border, #2a2a2a)",
			"background:var(--color-surface-secondary, #1a1a1a)",
			"color:var(--color-text-secondary, #d4d4d4)",
			"box-shadow:0 4px 12px rgba(0,0,0,0.25)",
			"pointer-events:none",
			"white-space:normal",
			"word-break:break-word",
		].join(";");
		document.body.appendChild(tip);

		// Position above trigger by default; flip below if no room.
		const tipRect = tip.getBoundingClientRect();
		const above = rect.top - tipRect.height - GAP;
		const below = rect.bottom + GAP;
		const top = above < MARGIN ? below : above;
		let left = rect.left + rect.width / 2 - tipRect.width / 2;
		left = Math.max(MARGIN, Math.min(left, window.innerWidth - tipRect.width - MARGIN));
		tip.style.top = `${Math.round(top)}px`;
		tip.style.left = `${Math.round(left)}px`;
	}

	function hide() {
		if (tip) {
			tip.remove();
			tip = null;
		}
	}

	function onEnter() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(show, DELAY);
	}

	function onLeave() {
		if (timer) clearTimeout(timer);
		timer = null;
		hide();
	}

	node.addEventListener("mouseenter", onEnter);
	node.addEventListener("mouseleave", onLeave);
	node.addEventListener("focusin", onEnter);
	node.addEventListener("focusout", onLeave);

	return {
		update(newText: string | null | undefined) {
			current = newText ?? "";
			if (tip) {
				tip.textContent = current;
			}
		},
		destroy() {
			if (timer) clearTimeout(timer);
			hide();
			node.removeEventListener("mouseenter", onEnter);
			node.removeEventListener("mouseleave", onLeave);
			node.removeEventListener("focusin", onEnter);
			node.removeEventListener("focusout", onLeave);
		},
	};
}
