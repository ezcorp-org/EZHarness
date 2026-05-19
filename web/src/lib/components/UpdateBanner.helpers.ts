/**
 * Pure logic for the UpdateBanner component. Lifted out of the Svelte file
 * so it can be unit-tested without a component-mounting framework.
 */

export type VersionInfo = {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	checkedAt: string | null;
	source: "github-releases" | "disabled";
	releaseUrl?: string;
};

export const DISMISS_STORAGE_KEY = "ezcorp-update-dismissed";

/**
 * True when the banner should render: the API says an update is available
 * AND the user hasn't dismissed THIS specific latest version in the current
 * session.
 *
 * Keyed by `latest` so that if a newer version lands after the user
 * dismissed the previous one, the banner reappears.
 */
export function shouldShowBanner(
	info: VersionInfo | null,
	storage: Pick<Storage, "getItem"> | null,
): boolean {
	if (!info?.updateAvailable) return false;
	if (!info.latest) return false;
	if (!storage) return true;
	return storage.getItem(DISMISS_STORAGE_KEY) !== info.latest;
}

/**
 * Value to persist to sessionStorage when the user dismisses. Always the
 * current `latest` string — so re-mounting within the session with the same
 * latest won't re-show, but a newer release will.
 */
export function dismissValue(info: VersionInfo): string | null {
	return info.latest ?? null;
}
