import { test, expect, describe } from "bun:test";
import {
	DISMISS_STORAGE_KEY,
	dismissValue,
	shouldShowBanner,
	type VersionInfo,
} from "../lib/components/UpdateBanner.helpers";

/**
 * Minimal in-memory mock of the sessionStorage interface we depend on.
 * Only `getItem` + `setItem` are needed; the component never calls
 * `removeItem`, `clear`, `key`, or `length`.
 */
function makeStorage(seed: Record<string, string> = {}): Storage {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		get length() {
			return map.size;
		},
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
		clear: () => map.clear(),
		key: (i) => Array.from(map.keys())[i] ?? null,
	};
}

const mkInfo = (over: Partial<VersionInfo> = {}): VersionInfo => ({
	current: "0.1.0",
	latest: "0.2.0",
	updateAvailable: true,
	checkedAt: "2026-04-21T00:00:00.000Z",
	source: "github-releases",
	releaseUrl: "https://example.com/r",
	...over,
});

describe("shouldShowBanner", () => {
	test("false when info is null (before /api/version responds)", () => {
		expect(shouldShowBanner(null, makeStorage())).toBe(false);
	});

	test("false when updateAvailable is false", () => {
		expect(shouldShowBanner(mkInfo({ updateAvailable: false }), makeStorage())).toBe(false);
	});

	test("false when latest is null (disabled mode or no release found)", () => {
		expect(
			shouldShowBanner(mkInfo({ latest: null, updateAvailable: false, source: "disabled" }), makeStorage()),
		).toBe(false);
	});

	test("true when update is available and storage is empty", () => {
		expect(shouldShowBanner(mkInfo(), makeStorage())).toBe(true);
	});

	test("false when the user dismissed this exact latest version", () => {
		const storage = makeStorage({ [DISMISS_STORAGE_KEY]: "0.2.0" });
		expect(shouldShowBanner(mkInfo({ latest: "0.2.0" }), storage)).toBe(false);
	});

	test("true when a NEWER version lands after a dismissal", () => {
		// User dismissed 0.2.0; a 0.3.0 release drops; the banner should reappear.
		const storage = makeStorage({ [DISMISS_STORAGE_KEY]: "0.2.0" });
		expect(shouldShowBanner(mkInfo({ latest: "0.3.0" }), storage)).toBe(true);
	});

	test("true when storage reference is missing (SSR / no-storage environment)", () => {
		expect(shouldShowBanner(mkInfo(), null)).toBe(true);
	});

	test("uses the canonical DISMISS_STORAGE_KEY (cannot drift silently)", () => {
		// Enforces the exported key name so a future refactor touching either
		// side flags the test.
		expect(DISMISS_STORAGE_KEY).toBe("ezcorp-update-dismissed");
	});
});

describe("dismissValue", () => {
	test("returns latest when present", () => {
		expect(dismissValue(mkInfo({ latest: "0.2.0" }))).toBe("0.2.0");
	});

	test("returns null when latest is null (nothing to persist)", () => {
		expect(dismissValue(mkInfo({ latest: null }))).toBeNull();
	});
});

describe("dismissal roundtrip (integration of both helpers)", () => {
	test("shouldShow=true → dismiss → shouldShow=false on next check", () => {
		const storage = makeStorage();
		const info = mkInfo({ latest: "0.2.0" });

		expect(shouldShowBanner(info, storage)).toBe(true);

		// Simulate the component's dismiss(): component writes dismissValue to
		// DISMISS_STORAGE_KEY.
		const val = dismissValue(info);
		expect(val).not.toBeNull();
		storage.setItem(DISMISS_STORAGE_KEY, val!);

		expect(shouldShowBanner(info, storage)).toBe(false);
	});

	test("dismiss of 0.2.0 does NOT suppress a 0.3.0 banner", () => {
		const storage = makeStorage();
		const first = mkInfo({ latest: "0.2.0" });

		const val = dismissValue(first);
		storage.setItem(DISMISS_STORAGE_KEY, val!);
		expect(shouldShowBanner(first, storage)).toBe(false);

		const second = mkInfo({ latest: "0.3.0" });
		expect(shouldShowBanner(second, storage)).toBe(true);
	});
});
