/**
 * `installMcpServerSchema.name` — the one extension-name writer that never
 * passes through `manifest.ts`.
 *
 * `installMcpExtension` synthesises its own manifest and calls
 * `createExtension` directly, so this schema is the ONLY validation between
 * a request body and a row whose `name` reaches the filesystem: it is what
 * `extensionDataDir()` uses for the MCP sandbox's read-write work dir, and
 * what an uninstall's `?purgeData=1` deletes.
 *
 * While this field was `z.string().min(1)`, a name like
 * `../extension-data/task-tracking` was accepted. The row landed with
 * `isBundled=false`, so the uninstall route's built-in guard passed, and
 * `purgeData` then erased a BUILT-IN extension's store. `isRemovableDataDir`
 * now refuses that shape independently — these two gates are deliberately
 * redundant, and this file is the outer one.
 */
import { describe, test, expect } from "vitest";
import { installMcpServerSchema } from "../routes/api/mcp-servers/schema";

const server = { transport: "http" as const, name: "s", url: "http://127.0.0.1:9/" };

function parseName(name: string) {
	return installMcpServerSchema.safeParse({ name, server });
}

describe("installMcpServerSchema — name", () => {
	test("accepts ordinary manifest names", () => {
		for (const name of ["notes", "ez-factory", "ai_kit", "web.search", "x0"]) {
			expect(parseName(name).success).toBe(true);
		}
	});

	test("refuses the traversal that reached another extension's data store", () => {
		for (const name of [
			"../extension-data/task-tracking",
			"x/../../extension-data/ask-user",
			"..",
			"../../data",
		]) {
			expect(parseName(name).success).toBe(false);
		}
	});

	test("refuses path separators and absolute paths", () => {
		for (const name of ["a/b", "a\\b", "/etc", "/"]) {
			expect(parseName(name).success).toBe(false);
		}
	});

	test("refuses the shapes the manifest pattern excludes", () => {
		for (const name of ["", "Uppercase", "-leading", ".leading", "has space", "a".repeat(65)]) {
			expect(parseName(name).success).toBe(false);
		}
	});

	test("the refusal explains itself", () => {
		// The MCP install form surfaces this message verbatim, so it has to
		// tell the user what a valid name looks like rather than "Invalid".
		const err = parseName("../oops");
		expect(err.success).toBe(false);
		if (err.success) throw new Error("unreachable");
		expect(err.error.issues[0]!.message).toMatch(/lowercase alphanumeric/);
	});

	test("accepts the boundary length exactly", () => {
		expect(parseName("a".repeat(64)).success).toBe(true);
	});
});
