export function isChatDisabled(streaming: boolean, connectionState: string): boolean {
	return streaming || connectionState !== "connected";
}

export function chatPlaceholder(connectionState: string, defaultPlaceholder: string): string {
	return connectionState !== "connected" ? "Reconnecting..." : defaultPlaceholder;
}
