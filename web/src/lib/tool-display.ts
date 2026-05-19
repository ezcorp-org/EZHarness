/**
 * Shared tool-call display utilities.
 *
 * Extracted from TaskLogsPanel and TeamChatPanel to eliminate duplication.
 * These map tool-call statuses (success/error/pending), which differ from
 * the task-level getStatusIcon/getStatusColor in tool-cards/utils.ts.
 */

export function toolStatusIcon(status: string): string {
	if (status === 'success') return '\u2713';
	if (status === 'error') return '\u2717';
	return '\u2026';
}

export function toolStatusColor(status: string): string {
	if (status === 'success') return 'text-green-400';
	if (status === 'error') return 'text-red-400';
	return 'text-yellow-400';
}

export function formatInput(input: Record<string, unknown> | null): string {
	if (!input) return '';
	const primary = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url;
	if (primary) return String(primary);
	return JSON.stringify(input, null, 2);
}
