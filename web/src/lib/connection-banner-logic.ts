export type ConnectionState = "connected" | "disconnected" | "reconnecting" | "failed";

/** Whether the banner should be visible */
export function isBannerVisible(state: ConnectionState, showConnected: boolean): boolean {
	return state === "reconnecting" || state === "failed" || state === "disconnected" || showConnected;
}

/** Banner color class */
export function bannerColorClass(state: ConnectionState, showConnected: boolean): string {
	if (showConnected && state === "connected") return "bg-green-600/90 text-white";
	if (state === "failed") return "bg-red-600/90 text-white";
	return "bg-amber-500/90 text-white";
}
