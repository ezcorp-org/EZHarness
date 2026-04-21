export type ThemeMode = "dark" | "light" | "system";

const STORAGE_KEY = "ezcorp-theme";

function isBrowser(): boolean {
	return typeof window !== "undefined";
}

/** Resolve whether effective theme is dark, considering 'system' mode */
export function getEffectiveDark(mode: ThemeMode): boolean {
	if (mode === "dark") return true;
	if (mode === "light") return false;
	// system: use OS preference
	if (isBrowser()) {
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	}
	return true; // default to dark during SSR
}

/** Toggle .dark class on documentElement and update OS chrome meta tags */
export function applyTheme(isDark: boolean): void {
	if (!isBrowser()) return;
	document.documentElement.classList.toggle("dark", isDark);
	const colorScheme = document.querySelector('meta[name="color-scheme"]');
	const themeColor = document.querySelector('meta[name="theme-color"]');
	if (colorScheme) colorScheme.setAttribute("content", isDark ? "dark" : "light");
	if (themeColor) themeColor.setAttribute("content", isDark ? "#111827" : "#ffffff");
}

let mediaQuery: MediaQueryList | null = null;
let mediaHandler: ((e: MediaQueryListEvent) => void) | null = null;

/** Read stored preference and apply; listen for OS changes when in system mode */
export function initTheme(): void {
	if (!isBrowser()) return;
	const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
	const mode: ThemeMode = stored ?? "system";
	applyTheme(getEffectiveDark(mode));

	// Listen for OS preference changes when in system mode
	if (mode === "system") {
		listenForSystemChanges();
	}
}

function listenForSystemChanges(): void {
	cleanupMediaListener();
	mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	mediaHandler = (e: MediaQueryListEvent) => {
		const current = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
		if (!current || current === "system") {
			applyTheme(e.matches);
		}
	};
	mediaQuery.addEventListener("change", mediaHandler);
}

function cleanupMediaListener(): void {
	if (mediaQuery && mediaHandler) {
		mediaQuery.removeEventListener("change", mediaHandler);
		mediaQuery = null;
		mediaHandler = null;
	}
}

/** Save a specific theme mode and apply it */
export function setTheme(mode: ThemeMode): void {
	if (!isBrowser()) return;
	if (mode === "system") {
		localStorage.removeItem(STORAGE_KEY);
	} else {
		localStorage.setItem(STORAGE_KEY, mode);
	}
	applyTheme(getEffectiveDark(mode));

	if (mode === "system") {
		listenForSystemChanges();
	} else {
		cleanupMediaListener();
	}
}

/** Toggle between dark and light (simple two-state toggle) */
export function toggleTheme(): void {
	if (!isBrowser()) return;
	const isDark = document.documentElement.classList.contains("dark");
	const newMode: ThemeMode = isDark ? "light" : "dark";
	setTheme(newMode);
}
