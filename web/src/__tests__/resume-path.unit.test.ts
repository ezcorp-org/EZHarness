import { test, expect, describe } from "vitest";
import {
	projectIdFromPath,
	isResumablePath,
	resolveResumeTarget,
	consumeResumePath,
	forgetResumePath,
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

	// The `(app)` layout mirrors this into `store.activeProjectId`, so any
	// route below returning non-null would kick the user out of their project.
	// `[id]` is deliberately NOT unique to `/project/[id]` — these four routes
	// declare the same param name, which is exactly why the layout parses the
	// PATHNAME instead of reading `page.params.id`.
	test("returns null for the other routes that also declare an [id] param", () => {
		expect(projectIdFromPath("/extensions/ext-1")).toBeNull();
		expect(projectIdFromPath("/extensions/ext-1/audit")).toBeNull();
		expect(projectIdFromPath("/marketplace/listing-9")).toBeNull();
		expect(projectIdFromPath("/runs/run-3")).toBeNull();
	});

	test("only matches the project segment at the start of the path", () => {
		// A nested or suffixed segment must not be mistaken for the real one.
		expect(projectIdFromPath("/extensions/project/p1")).toBeNull();
		expect(projectIdFromPath("/projects/p1")).toBeNull();
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

describe("consumeResumePath", () => {
	test("returns the saved path AND clears it in one step", () => {
		// One-shot by design: re-reading it is what let a bouncing route
		// ping-pong with `/` forever.
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard");

		expect(consumeResumePath(s)).toBe("/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
		expect(consumeResumePath(s)).toBeNull();
	});

	test("a second open after a bounce resolves to a fallback, not the bouncing route", () => {
		// The loop, end to end: `/` consumes `/admin/dashboard`, the guard
		// bounces home, and the return trip must NOT resolve back into it.
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard");
		s.setItem(ACTIVE_PROJECT_KEY, "p1");

		const first = resolveResumeTarget({
			lastPath: consumeResumePath(s),
			savedProjectId: s.getItem(ACTIVE_PROJECT_KEY),
			validProjectIds: ["p1"],
		});
		expect(first).toBe("/admin/dashboard");

		const second = resolveResumeTarget({
			lastPath: consumeResumePath(s),
			savedProjectId: s.getItem(ACTIVE_PROJECT_KEY),
			validProjectIds: ["p1"],
		});
		expect(second).toBe("/project/p1/chat");
		expect(second).not.toBe(first);
	});

	test("leaves the other resume keys alone", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/hub");
		s.setItem(ACTIVE_PROJECT_KEY, "p1");
		s.setItem(`${LAST_CHAT_PREFIX}p1`, "conv-1");

		consumeResumePath(s);

		expect(s.getItem(ACTIVE_PROJECT_KEY)).toBe("p1");
		expect(s.getItem(`${LAST_CHAT_PREFIX}p1`)).toBe("conv-1");
	});

	test("returns null when there is nothing saved", () => {
		expect(consumeResumePath(new FakeStorage())).toBeNull();
	});

	test("returns null when storage is unavailable (SSR)", () => {
		expect(consumeResumePath(null)).toBeNull();
	});
});

describe("forgetResumePath", () => {
	test("clears the saved path when it is the route being bounced off", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard");
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
	});

	test("clears a descendant of the bounced route", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard/usage");
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
	});

	test("ignores the query string and hash when matching", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard?tab=usage#top");
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
	});

	test("leaves an unrelated saved path alone", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/project/p1/chat");
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBe("/project/p1/chat");
	});

	test("does not clear a route that merely shares a name prefix", () => {
		// `/admin/dashboard-archive` is a different route, not a descendant.
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard-archive");
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBe("/admin/dashboard-archive");
	});

	test("is a no-op when nothing is saved", () => {
		const s = new FakeStorage();
		forgetResumePath(s, "/admin/dashboard");
		expect(s.getItem(LAST_PATH_KEY)).toBeNull();
	});

	test("tolerates unavailable storage (SSR)", () => {
		expect(() => forgetResumePath(null, "/admin/dashboard")).not.toThrow();
	});

	test("breaks the loop: a bounced route is not resumed into again", () => {
		const s = new FakeStorage();
		s.setItem(LAST_PATH_KEY, "/admin/dashboard");
		s.setItem(ACTIVE_PROJECT_KEY, "p1");

		// `/` resumes there, the route renders and the layout re-records it,
		// then its guard bounces and forgets it.
		expect(consumeResumePath(s)).toBe("/admin/dashboard");
		s.setItem(LAST_PATH_KEY, "/admin/dashboard"); // afterNavigate re-records
		forgetResumePath(s, "/admin/dashboard");

		expect(
			resolveResumeTarget({
				lastPath: consumeResumePath(s),
				savedProjectId: s.getItem(ACTIVE_PROJECT_KEY),
				validProjectIds: ["p1"],
			}),
		).toBe("/project/p1/chat");
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
