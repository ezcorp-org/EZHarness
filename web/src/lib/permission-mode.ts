/**
 * Pure utility functions for permission mode display.
 * Extracted for unit testability without Svelte component rendering.
 */

export type PermissionMode = "ask" | "auto-edit" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = ["ask", "auto-edit", "yolo"];

/** Map permission mode to a CSS color class for the indicator dot */
export function modeToColor(mode: PermissionMode): string {
	switch (mode) {
		case "ask": return "bg-red-500";
		case "auto-edit": return "bg-yellow-500";
		case "yolo": return "bg-green-500";
	}
}

/** Map permission mode to a human-readable label */
export function modeToLabel(mode: PermissionMode): string {
	switch (mode) {
		case "ask": return "Ask";
		case "auto-edit": return "Auto-edit";
		case "yolo": return "YOLO";
	}
}

/** Map permission mode to a description for tooltip/dropdown */
export function modeToDescription(mode: PermissionMode): string {
	switch (mode) {
		case "ask": return "Ask before running dangerous tools";
		case "auto-edit": return "Auto-approve edits, ask for shell commands";
		case "yolo": return "Auto-approve everything";
	}
}
