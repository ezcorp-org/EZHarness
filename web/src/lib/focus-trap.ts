/**
 * Focus trap utility for modal dialogs.
 * Traps Tab/Shift+Tab within a container and restores focus on cleanup.
 */

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createFocusTrap(container: HTMLElement): () => void {
	const previouslyFocused = document.activeElement as HTMLElement | null;

	// Focus first focusable element
	const focusableElements = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
	if (focusableElements.length > 0) {
		focusableElements[0]!.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== "Tab") return;

		const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
		if (focusable.length === 0) return;

		const first = focusable[0]!;
		const last = focusable[focusable.length - 1]!;

		if (e.shiftKey) {
			if (document.activeElement === first) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	container.addEventListener("keydown", handleKeydown);

	return () => {
		container.removeEventListener("keydown", handleKeydown);
		previouslyFocused?.focus();
	};
}
