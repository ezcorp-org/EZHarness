/**
 * Unit tests for `extractCommandText` — the pure helper that feeds the
 * always-visible command code block on dev-command cards.
 *
 * Core contract (user requirement): the returned string is the EXACT,
 * FULL command the tool was invoked with — never truncated, never
 * transformed — so the rendered block always matches the command used.
 */
import { test, expect, describe } from "bun:test";
import { extractCommandText } from "../lib/components/tool-cards/utils.js";

describe("extractCommandText — exact, full, untruncated", () => {
	test("Bash: returns input.command verbatim", () => {
		const command = "echo hello world";
		expect(extractCommandText({ command })).toBe(command);
	});

	test("no truncation: a long (>200-char) command round-trips exactly", () => {
		const command =
			"grep -rn --line-buffered 'needle' src | " +
			"awk '{print $1}' | sort -u | " +
			"xargs -I{} sh -c 'echo processing {}; cat {} | head -n 50' | " +
			"tee /tmp/out.log && " +
			"echo 'done with a very long pipeline that exceeds any header-sized preview budget by a wide margin so truncation would definitely be visible'";
		// Far beyond the 60-char header-preview budget the old truncated
		// summary used — so any truncation would be unmistakable.
		expect(command.length).toBeGreaterThan(200);
		const out = extractCommandText({ command });
		expect(out).toBe(command);
		expect(out).toHaveLength(command.length);
		expect(out).not.toContain("...");
	});

	test("preserves quotes, pipes, $(), newlines and leading/trailing whitespace", () => {
		const command = `  for f in $(ls *.ts); do\n  echo "file: \${f}" | grep -E 'a|b';\ndone  `;
		expect(extractCommandText({ command })).toBe(command);
	});

	test("Edit/Write: falls back to file_path (full path)", () => {
		const file_path = "/home/dev/work/EZCorp/ez-corp-ai/web/src/lib/components/tool-cards/CollapsibleCard.svelte";
		expect(extractCommandText({ file_path, old_string: "a", new_string: "b" })).toBe(file_path);
	});

	test("grep/glob: falls back to pattern", () => {
		expect(extractCommandText({ pattern: "foo.*bar" })).toBe("foo.*bar");
	});

	test("priority: command wins over file_path/pattern when several present", () => {
		expect(
			extractCommandText({ command: "ls -la", file_path: "/x", pattern: "p" }),
		).toBe("ls -la");
	});

	test("non-string primary arg is stringified exactly", () => {
		expect(extractCommandText({ command: 42 })).toBe("42");
	});
});

describe("extractCommandText — no usable arg → undefined (caller omits the block)", () => {
	test("empty-string command → undefined", () => {
		expect(extractCommandText({ command: "" })).toBeUndefined();
	});

	test("input without any known key → undefined", () => {
		expect(extractCommandText({ foo: "bar" })).toBeUndefined();
	});

	test("null / undefined / non-object input → undefined", () => {
		expect(extractCommandText(null)).toBeUndefined();
		expect(extractCommandText(undefined)).toBeUndefined();
		expect(extractCommandText("a string")).toBeUndefined();
		expect(extractCommandText(123)).toBeUndefined();
	});
});
