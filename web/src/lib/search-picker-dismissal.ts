/**
 * Shared dismissal policy for search pickers that render in a BottomSheet on
 * small screens. A sheet can mount between pointerdown and click, so preserve
 * the opening gesture and let the sheet own clicks within its body.
 */
export function createSearchPickerDismissal({
	getInput,
	isOpen,
	dismiss,
	isInsidePicker,
}: {
	getInput: () => HTMLElement | undefined;
	isOpen: () => boolean;
	dismiss: () => void;
	isInsidePicker?: (target: Element) => boolean;
}) {
	let pressBeganOnInput = false;
	let blurTimer: ReturnType<typeof setTimeout> | undefined;

	function cancelBlurDismissal() {
		if (blurTimer) {
			clearTimeout(blurTimer);
			blurTimer = undefined;
		}
	}

	function scheduleBlurDismissal() {
		cancelBlurDismissal();
		blurTimer = setTimeout(() => {
			blurTimer = undefined;
			dismiss();
		}, 150);
	}

	function onDocumentPointerDown(event: PointerEvent) {
		pressBeganOnInput = !!getInput()?.contains(event.target as Node);
	}

	function onDocumentClick(event: MouseEvent) {
		if (!isOpen() || pressBeganOnInput) return;
		const target = event.target as Node | null;
		if (!target || getInput()?.contains(target)) return;
		if (target instanceof Element) {
			if (target.closest("[data-testid='bottom-sheet']")) return;
			if (isInsidePicker?.(target)) return;
		}
		dismiss();
	}

	return {
		cancelBlurDismissal,
		scheduleBlurDismissal,
		onDocumentPointerDown,
		onDocumentClick,
		destroy: cancelBlurDismissal,
	};
}
