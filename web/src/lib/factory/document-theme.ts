/**
 * Follows the app's effective theme (the `.dark` class `applyTheme` in
 * `$lib/theme` sets on the root element), for factory views that draw their
 * own colours, such as the graph canvas. Calls back once now and on every
 * change; returns the unsubscribe.
 */
export function observeDocumentDark(onChange: (isDark: boolean) => void, root: HTMLElement = document.documentElement): () => void {
	onChange(root.classList.contains("dark"));
	const observer = new MutationObserver(() => onChange(root.classList.contains("dark")));
	observer.observe(root, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}
