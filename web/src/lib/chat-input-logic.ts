/** Commit the DOM projection and caret before another native input can arrive. */
export function setComposerDisplay(
	textarea: HTMLTextAreaElement | undefined,
	display: string,
	cursor: number,
): void {
	if (!textarea) return;
	textarea.value = display;
	textarea.setSelectionRange(cursor, cursor);
	textarea.focus();
}

export function isChatDisabled(streaming: boolean, connectionState: string): boolean {
	return streaming || connectionState !== "connected";
}

export function chatPlaceholder(connectionState: string, defaultPlaceholder: string): string {
	return connectionState !== "connected" ? "Reconnecting..." : defaultPlaceholder;
}

export function shouldAutofocusComposer(args: {
	loaded: boolean;
	messageCount: number;
	disabled: boolean;
}): boolean {
	return args.loaded && args.messageCount === 0 && !args.disabled;
}

/**
 * True when a keydown belongs to an IME composition: Enter confirms a
 * Japanese, Chinese or Korean candidate there, it does not mean "send".
 * Safari ends the composition before that keydown, so it is marked only
 * by keyCode 229.
 */
export function isImeKeydown(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

/** Enter without Shift, outside an IME composition: the "send" key. */
export function isSubmitEnter(e: KeyboardEvent): boolean {
	return e.key === "Enter" && !e.shiftKey && !isImeKeydown(e);
}
