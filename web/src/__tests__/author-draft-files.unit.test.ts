/**
 * `readAuthorDraftFiles` — the ONE reader for an extension-author draft
 * directory (previously duplicated in `+page.server.ts` and the draft
 * API route, each with its own silent skip-on-error).
 *
 * The behavior under test is the fix: a file that cannot be read is
 * still SKIPPED (one bad file must not 500 the editor) but is no longer
 * skipped SILENTLY — the caller gets its name and the reason, and shows
 * them. Editing a draft you can only partly see and then installing it
 * is how content gets lost.
 *
 * The unreadable cases are produced with shapes that fail for EVERY
 * user (a directory where a file is expected, a file where a directory
 * is expected) rather than chmod, which is a no-op when the suite runs
 * as root.
 */

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTHOR_DRAFT_FILES,
	readAuthorDraftFiles,
} from "../lib/server/author-draft-files.js";

let DIR = "";

beforeEach(() => {
	DIR = join(tmpdir(), `draft-files-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(DIR, { recursive: true });
});
afterEach(() => {
	try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("readAuthorDraftFiles", () => {
	test("reads every allowlisted file and reports nothing unreadable", () => {
		writeFileSync(join(DIR, "ezcorp.config.ts"), "export default {};\n");
		writeFileSync(join(DIR, "index.ts"), "// entry\n");
		writeFileSync(join(DIR, ".gitignore"), "node_modules\n");

		const { files, unreadable } = readAuthorDraftFiles(DIR);
		expect(files["ezcorp.config.ts"]).toBe("export default {};\n");
		expect(files["index.ts"]).toBe("// entry\n");
		expect(files[".gitignore"]).toBe("node_modules\n");
		expect(unreadable).toEqual([]);
	});

	test("files outside the allowlist are ignored entirely (not reported)", () => {
		writeFileSync(join(DIR, "ezcorp.config.ts"), "x\n");
		writeFileSync(join(DIR, "secret.key"), "nope\n");

		const { files, unreadable } = readAuthorDraftFiles(DIR);
		expect(Object.keys(files)).toEqual(["ezcorp.config.ts"]);
		expect(unreadable).toEqual([]);
	});

	test("a missing directory is empty, not an error", () => {
		expect(readAuthorDraftFiles(join(DIR, "nope"))).toEqual({
			files: {},
			unreadable: [],
		});
	});

	test("an unreadable allowlisted entry is REPORTED, and the rest still load", () => {
		writeFileSync(join(DIR, "ezcorp.config.ts"), "good\n");
		// A directory where a file is expected — readFileSync throws EISDIR
		// for every user, root included.
		mkdirSync(join(DIR, "README.md"));

		const { files, unreadable } = readAuthorDraftFiles(DIR);
		expect(files["ezcorp.config.ts"]).toBe("good\n");
		expect(files["README.md"]).toBeUndefined();
		expect(unreadable.length).toBe(1);
		expect(unreadable[0]!.name).toBe("README.md");
		expect(unreadable[0]!.error.length).toBeGreaterThan(0);
	});

	test("a draft path that is not a directory is reported, not thrown", () => {
		const asFile = join(DIR, "not-a-dir");
		writeFileSync(asFile, "x");
		const { files, unreadable } = readAuthorDraftFiles(asFile);
		expect(files).toEqual({});
		expect(unreadable.length).toBe(1);
		expect(unreadable[0]!.name).toBe(".");
	});

	test("the allowlist is the scaffolder's seven keys", () => {
		expect([...AUTHOR_DRAFT_FILES].sort()).toEqual([
			".gitignore",
			"README.md",
			"ezcorp.config.ts",
			"index.test.ts",
			"index.ts",
			"package.json",
			"tsconfig.json",
		]);
	});
});
