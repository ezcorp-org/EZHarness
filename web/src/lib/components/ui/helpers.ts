/** Standard debounce: delays invocation until `ms` milliseconds of inactivity. */
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	ms: number,
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: Parameters<T>) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/** Strips directory traversal sequences and null bytes from a path (client-side layer). */
export function sanitizePath(path: string): string {
	return path.replace(/\0/g, '').replace(/\.\.(?=\/|$)/g, '');
}

/** Splits a path into directory and partial filename. */
export function splitPath(path: string): { dir: string; partial: string } {
	const last = path.lastIndexOf("/");
	if (last === -1) return { dir: "~", partial: path };
	return { dir: path.slice(0, last) || "/", partial: path.slice(last + 1) };
}

/** Filters filesystem entries by allowed extensions (directories always pass). */
export function filterByExtensions(
	entries: { name: string; isDir: boolean }[],
	extensions: string[],
): { name: string; isDir: boolean }[] {
	return entries.filter((e) => e.isDir || extensions.some((ext) => e.name.endsWith(ext)));
}

/** Filters a list of string options by a query (case-insensitive substring). */
export function filterOptions(options: string[], query: string): string[] {
	return query ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase())) : options;
}

/** Filters suggestions excluding already-selected items and optionally matching a query. */
export function filterSuggestions(suggestions: string[], existing: string[], query: string): string[] {
	return suggestions.filter(
		(s) => !existing.includes(s) && (!query || s.toLowerCase().includes(query.toLowerCase())),
	);
}

/** Converts an ISO 8601 value to the format expected by a date/datetime-local input. */
export function formatDateForInput(value: string, isDatetime: boolean): string {
	if (!value) return "";
	if (isDatetime && value.includes("T")) {
		return value.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "").slice(0, 16);
	}
	return value.slice(0, 10);
}

/** Converts a date/datetime-local input value to ISO 8601. */
export function parseDateFromInput(raw: string, isDatetime: boolean): string {
	if (isDatetime) {
		return raw ? new Date(raw).toISOString() : "";
	}
	return raw;
}
