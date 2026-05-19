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
