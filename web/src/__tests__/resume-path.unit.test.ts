import { test, expect, describe } from "vitest";
import {
	projectIdFromPath,
	isResumablePath,
	resolveResumeTarget,
	clearResumeState,
	LAST_PATH_KEY,
	ACTIVE_PROJECT_KEY,
	LAST_CHAT_PREFIX,
	GLOBAL_PROJECT_ID,
} from "../lib/resume-path";

/** Minimal in-memory Storage. `keyReturnsNullAt` forces `key(i)` to yield null
 *  for a chosen index, exercising the `key !== null` guard in clearResumeState. */
class FakeStorage implements Storage {
	private map = new Map<string, string>();
	keyReturnsNullAt: number | null = null;
	get length(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
	}
	getItem(key: string): string | null {
		return this.map.has(key) ? (this.map.get(key) as string) : null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	key(index: number): string | null {
		if (this.keyReturnsNullAt === index) return null;
		return Array.from(this.map.keys())[index] ?? null;
	}
	[name: string]: unknown;
}

describe("projectIdFromPath", () => {
	test("extracts id from a project-scoped path", () => {
		expect(projectIdFromPath("/project/p1/chat/abc")).toBe("p1");
		expect(projectIdFromPath("/project/p1")).toBe("p1");
		expect(projectIdFromPath("/project/p1?tab=x")).toBe("p1");
	});

	test("decodes percent-encoded ids", () => {
		expect(projectIdFromPath("/project/a%20b/chat")).toBe("a b");
	});

	test("returns null for non-project paths", () => {
		expect(projectIdFromPath("/hub")).toBeNull();
		expect(projectIdFromPath("/")).toBeNull();
		expect(projectIdFromPath("/project/")).toBeNull();
	});
});

describe("isResumablePath", () => {
	test("rejects empty, null, root, and non-app paths", () => {
		expect(isResumablePath(null, [])).toBe(false);
		expect(isResumablePath("", [])).toBe(false);
		expect(isResumablePath("/", [])).toBe(false);
		expect(isResumablePath("relative/path", [])).toBe(false);
	});

	test("accepts a project path only when the project still exists", () => {
		expect(isResumablePath("/project/p1/chat", ["p1"])).toBe(true);
		expect(isResumablePath("/project/p1/chat", [])).toBe(false);
	});

	test("treats the global workspace as always valid", () => {
		expect(isResumablePath("/project/global/chat", [])).toBe(true);
	});

	test("accepts non-project app routes unconditionally", () => {
		expect(isResumablePath("/hub", [])).toBe(true);
		expect(isResumablePath("/settings/models", [])).toBe(true);
	});
});

describe("resolveResumeTarget", () => {
	test("resumes to the exact last path when it is valid", () => {
		expect(
			resolveResumeTarget({
				lastPath: "/project/p1/chat/conv-9",
				savedProjectId: "p1",
				validProjectIds: ["p1"],
			}),
		).toBe("/project/p1/chat/conv-9");
	});

	test("resumes to a non-project last path (e.g. settings)", () => {
		expect(
			resolveResumeTarget({
				lastPath: "/settings/models",
				savedProjectId: null,
				validProjectIds: [],
			}),
		).toBe("/settings/models");
	});

	test("falls back to the saved project chat when last path is unusable", () => {
		expect(
			resolveResumeTarget({
				lastPath: "/project/deleted/chat",
				savedProjectId: "p2",
				validProjectIds: ["p2"],
			}),
		).toBe("/project/p2/chat");
	});

	test("uses the saved project when there is no last path", () => {
		expect(
			resolveResumeTarget({ lastPath: null, savedProjectId: "p3", validProjectIds: ["p3"] }),
		).toBe("/project/p3/chat");
	});

	test("global saved project resolves to the global chat", () => {
		expect(
			resolveResumeTarget({
				lastPath: null,
				savedProjectId: GLOBAL_PROJECT_ID,
				validProjectIds: [],
			}),
		).toBe("/project/global/chat");
	});

	test("falls back to global when nothing is usable", () => {
		expect(
			resolveResumeTarget({ lastPath: null, savedProjectId: null, validProjectIds: [] }),
		).toBe("/project/global/chat");
		expect(
			resolveResumeTarget({
				lastPath: "/project/dead/chat",
				savedProjectId: "also-dead",
				validProjectIds: ["p1"],
			}),
		).toBe("/project/global/chat");
	});
});

describe("clearResumeState", () => {
	test("removes last-path, active project, and every per-project last-chat key", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/project/p1/chat/x");
		s.setItem(ACTIVE_PROJECT_KEY, "p1");
		s.setItem(`${LAST_CHAT_PREFIX}p1`, "conv-1");
		s.setItem(`${LAST_CHAT_PREFIX}p2`, "conv-2");
		s.setItem("pi-sidebar-collapsed", "true"); // unrelated — must survive

		clearResumeState(s);

		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
		expect(s.getItem(ACTIVE_PROJECT_KEY)).toBeNull();
		expect(s.getItem(`${LAST_CHAT_PREFIX}p1`)).toBeNull();
		expect(s.getItem(`${LAST_CHAT_PREFIX}p2`)).toBeNull();
		expect(s.getItem("pi-sidebar-collapsed")).toBe("true");
	});

	test("tolerates a null key() result", () => {
		const s = new FakeStorage();
		s.setItem(`${LAST_CHAT_PREFIX}p1`, "conv-1");
		s.setItem("keep-me", "1");
		s.keyReturnsNullAt = 0; // force the `key !== null` guard's false branch
		expect(() => clearResumeState(s)).not.toThrow();
		expect(s.getItem("keep-me")).toBe("1");
	});
});
