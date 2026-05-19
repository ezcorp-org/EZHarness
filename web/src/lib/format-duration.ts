/**
 * Shared duration / time formatting utilities.
 *
 * Extracted from TaskPanel, AssignmentPill, TaskLogsPanel, and TeamChatPanel
 * to eliminate duplication.
 */

/**
 * Format a duration in milliseconds as a compact string:
 * 45s / 2m 13s / 1h 07m / 3d 4h
 */
export function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 24) return `${totalHours}h ${minutes.toString().padStart(2, "0")}m`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}d ${hours}h`;
}

/**
 * Human-readable "time ago" label from an ISO date string.
 * Requires the current timestamp so the caller can drive reactivity.
 */
export function timeAgo(isoDate: string, now: number): string {
	const seconds = Math.max(0, Math.floor((now - new Date(isoDate).getTime()) / 1000));
	if (seconds < 5) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m ago`;
}

/**
 * Compact delta between two ISO date strings (e.g. "3m 12s").
 */
export function timeDelta(from: string, to: string): string {
	const ms = new Date(to).getTime() - new Date(from).getTime();
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
