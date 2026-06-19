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

/**
 * Splits a path into directory and partial filename. A bare entry (no
 * slash) is resolved relative to `root` — `"~"` by default (project /
 * sandbox-relative pickers), or `"/"` for an absolute-mode picker so a
 * typed-but-incomplete name never collapses to a non-absolute `~/…` value.
 */
export function splitPath(path: string, root = "~"): { dir: string; partial: string } {
	const last = path.lastIndexOf("/");
	if (last === -1) return { dir: root, partial: path };
	return { dir: path.slice(0, last) || "/", partial: path.slice(last + 1) };
}

/**
 * The directory to load when the user clicks "Browse". Mirrors the picker's
 * rule: a value with a partial filename browses its parent dir; a
 * slash-terminated (or empty) value browses itself, falling back to `root`.
 * Extracted (pure) so absolute vs `~`-relative rooting is unit-testable.
 */
export function browseDir(value: string, root = "~"): string {
	return value && !value.endsWith("/") ? splitPath(value, root).dir : value || root;
}

/**
 * Joins a picker `value` with a selected entry name into the next path.
 * Pure core of the picker's `select()` so absolute-mode rooting (no
 * `~`-relative or doubled-slash output) is unit-testable without Svelte.
 * Directories get a trailing slash (the picker keeps browsing into them).
 */
export function joinSelectedPath(
	value: string,
	entry: { name: string; isDir: boolean },
	root = "~",
): string {
	// Empty value seeds from the root, slash-terminated so an absolute
	// root (`/`) doesn't double its leading slash.
	const seed = value || (root.endsWith("/") ? root : `${root}/`);
	const { dir } = splitPath(seed, root);
	const base = seed.endsWith("/") ? seed : dir + "/";
	const joined = base === "/" ? "/" + entry.name : base + entry.name;
	return entry.isDir ? joined + "/" : joined;
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
