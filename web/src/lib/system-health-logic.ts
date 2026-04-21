export type SubsystemStatus = "up" | "down" | "ready" | "not_initialized" | "configured" | "not_configured";

export function statusColor(s: SubsystemStatus): string {
	if (s === "up" || s === "ready" || s === "configured") return "bg-green-500";
	if (s === "down" || s === "not_initialized" || s === "not_configured") return "bg-red-500";
	return "bg-gray-500";
}

export function statusLabel(s: SubsystemStatus): string {
	return s.replace(/_/g, " ");
}
