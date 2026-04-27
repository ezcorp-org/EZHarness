/**
 * Pure utility functions for tool card routing and security notes.
 * Extracted for unit testability without Svelte component rendering.
 */

/** Map cardType string to the component name that should render it */
export function getCardComponentName(cardType: string | undefined, permissionPending: boolean | undefined): string {
	if (permissionPending) return 'PermissionGate';
	switch (cardType) {
		case 'terminal': return 'TerminalCard';
		case 'diff': return 'DiffCard';
		case 'search-results': return 'SearchResultsCard';
		case 'task-list': return 'TaskListCard';
		case 'task-detail': return 'TaskDetailCard';
		case 'ask-user-question': return 'AskUserQuestionCard';
		case 'design-canvas': return 'DesignCanvasCard';
		default: return 'DefaultCard';
	}
}

/** Category-based security note for permission gate UI */
export function getSecurityNote(category: string | undefined): string {
	switch (category) {
		case 'execute': return 'This tool will run a shell command';
		case 'write': return 'This tool will modify files';
		case 'read': return '';
		default: return '';
	}
}

/** Strip ANSI escape codes from a string for plain-text copy */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the literal ESC (U+001B) byte that begins ANSI escape sequences is the entire purpose of this regex.
	return text.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}

/** Parse grep-style output (filepath:lineNum:content) into grouped results */
export interface GrepMatch {
	lineNum: number;
	content: string;
}

export interface GrepFileGroup {
	filePath: string;
	matches: GrepMatch[];
}

export function parseGrepOutput(raw: string): GrepFileGroup[] {
	if (!raw?.trim()) return [];

	const groups: Map<string, GrepMatch[]> = new Map();
	const lines = raw.split('\n');

	for (const line of lines) {
		if (!line.trim() || line === '--') continue;
		// Match filepath:lineNum:content or filepath:lineNum-content (context lines)
		const match = line.match(/^(.+?):(\d+)[:-](.*)$/);
		if (match) {
			const [, filePath, lineStr, content] = match;
			const lineNum = parseInt(lineStr!, 10);
			if (!groups.has(filePath!)) groups.set(filePath!, []);
			groups.get(filePath!)!.push({ lineNum, content: content! });
		}
	}

	return Array.from(groups.entries()).map(([filePath, matches]) => ({ filePath, matches }));
}

/** Parse glob-style output (newline-separated file paths) into a list */
export function parseGlobOutput(raw: string): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('[truncated'));
}

// ── DiffCard utils ──

/** Extract diff details (oldContent/newContent) from tool output */
export function extractDiffDetails(output: unknown): { oldContent?: string; newContent?: string } {
	if (!output || typeof output !== 'object') return {};
	const out = output as Record<string, unknown>;
	if (out.details && typeof out.details === 'object') {
		const d = out.details as Record<string, unknown>;
		return {
			oldContent: typeof d.oldContent === 'string' ? d.oldContent : undefined,
			newContent: typeof d.newContent === 'string' ? d.newContent : undefined,
		};
	}
	return {
		oldContent: typeof out.oldContent === 'string' ? out.oldContent : undefined,
		newContent: typeof out.newContent === 'string' ? out.newContent : undefined,
	};
}

/** Generate a unified diff string from old and new content */
export function generateDiffText(oldContent: string, newContent: string, filePath: string): string {
	if (!oldContent && !newContent) return '';
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	let diff = `--- a/${filePath}\n+++ b/${filePath}\n`;
	diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
	for (const line of oldLines) diff += `-${line}\n`;
	for (const line of newLines) diff += `+${line}\n`;
	return diff;
}

/** Detect if a file is new (empty oldContent with present newContent) */
export function isNewFile(oldContent?: string, newContent?: string): boolean {
	return !oldContent && !!newContent;
}

// ── TaskDetailCard utils ──

export interface TaskDetail {
	id?: string;
	title?: string;
	description?: string;
	status?: string;
	dueDate?: string;
	readyForAgent?: boolean;
	startedAt?: string;
	completedAt?: string;
	completionSummary?: string;
}

/** Parse tool output into a TaskDetail object, or null on failure */
export function parseTaskOutput(output: unknown): TaskDetail | null {
	if (output == null) return null;
	const raw = typeof output === 'string' ? output : JSON.stringify(output);
	try {
		const parsed = JSON.parse(raw);
		if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as TaskDetail;
	} catch {
		return null;
	}
}

/** Map task status to a badge with label and color class */
export function getStatusBadge(status?: string): { text: string; classes: string } {
	switch (status) {
		case 'completed': return { text: 'Completed', classes: 'bg-green-500/20 text-green-300' };
		case 'active': return { text: 'Active', classes: 'bg-blue-500/20 text-blue-300' };
		case 'pending': return { text: 'Pending', classes: 'bg-yellow-500/20 text-yellow-300' };
		case 'failed': return { text: 'Failed', classes: 'bg-red-500/20 text-red-300' };
		default: return { text: status ?? 'Unknown', classes: 'bg-gray-500/20 text-gray-300' };
	}
}

// ── TaskListCard utils ──

export interface TaskItem {
	id?: string;
	title?: string;
	name?: string;
	status?: string;
	priority?: number;
	dueDate?: string;
	readyForAgent?: boolean;
	createdAt?: string;
}

/** Parse tool output into a list of TaskItems */
export function parseListOutput(output: unknown): TaskItem[] {
	if (output == null) return [];
	const raw = typeof output === 'string' ? output : JSON.stringify(output);
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Detect if items are stacks (have 'name' but no 'status') */
export function isStackList(items: TaskItem[]): boolean {
	return items.length > 0 && items[0]?.name != null && items[0]?.status == null;
}

/** Map task status to a Tailwind color class */
export function getStatusColor(status?: string): string {
	switch (status) {
		case 'completed': return 'text-green-400';
		case 'active': return 'text-blue-400';
		case 'failed': return 'text-red-400';
		default: return 'text-[var(--color-text-muted)]';
	}
}

/** Map task status to an icon character */
export function getStatusIcon(status?: string): string {
	switch (status) {
		case 'completed': return '✓';
		case 'active': return '▶';
		case 'failed': return '✗';
		default: return '○';
	}
}

// ── DefaultCard / PermissionGate shared utils ──

/** Extract a summary key from tool input and truncate */
export function extractInputSummary(input: unknown, maxLen: number = 60): string | undefined {
	if (!input || typeof input !== 'object') return undefined;
	const inp = input as Record<string, unknown>;
	const key = inp.file_path ?? inp.path ?? inp.pattern ?? inp.command ?? inp.query ?? inp.url ?? inp.content;
	if (!key) return undefined;
	const s = String(key);
	return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

/** Truncate output for preview display */
export function formatOutputPreview(output: unknown, maxLen: number = 50): string | undefined {
	if (output == null) return undefined;
	const s = typeof output === 'string' ? output : JSON.stringify(output);
	if (!s || s === '{}' || s === '""') return undefined;
	return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}
