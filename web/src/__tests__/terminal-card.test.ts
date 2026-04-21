import { test, expect, describe } from "bun:test";
import { AnsiUp } from "ansi_up";
import { stripAnsi } from "../lib/components/tool-cards/utils.js";

describe("TerminalCard ANSI conversion", () => {
	const ansiUp = new AnsiUp();
	ansiUp.use_classes = true;

	test("converts ANSI color codes to HTML span elements with classes", () => {
		const input = "\x1b[31mError\x1b[0m: something went wrong";
		const html = ansiUp.ansi_to_html(input);
		expect(html).toContain("ansi-red-fg");
		expect(html).toContain("Error");
		expect(html).toContain("something went wrong");
	});

	test("converts bold ANSI codes to HTML with bold styling", () => {
		const input = "\x1b[1mBold text\x1b[0m";
		const html = ansiUp.ansi_to_html(input);
		expect(html).toContain("font-weight:bold");
		expect(html).toContain("Bold text");
	});

	test("converts green ANSI codes", () => {
		const input = "\x1b[32mSuccess\x1b[0m";
		const html = ansiUp.ansi_to_html(input);
		expect(html).toContain("ansi-green-fg");
		expect(html).toContain("Success");
	});

	test("handles plain text without ANSI codes", () => {
		const input = "hello world";
		const html = ansiUp.ansi_to_html(input);
		expect(html).toBe("hello world");
	});
});

describe("stripAnsi", () => {
	test("strips ANSI color codes from text", () => {
		const input = "\x1b[31mred\x1b[0m normal \x1b[32mgreen\x1b[0m";
		expect(stripAnsi(input)).toBe("red normal green");
	});

	test("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	test("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	test("strips complex ANSI sequences", () => {
		const input = "\x1b[1;31;42mstyledtext\x1b[0m";
		expect(stripAnsi(input)).toBe("styledtext");
	});
});
