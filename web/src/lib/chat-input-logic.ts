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
