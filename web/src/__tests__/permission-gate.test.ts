import { test, expect, describe } from "bun:test";
import { getSecurityNote } from "../lib/components/tool-cards/utils.js";

describe("getSecurityNote", () => {
	test("returns shell command message for 'execute' category", () => {
		expect(getSecurityNote("execute")).toBe("This tool will run a shell command");
	});

	test("returns file modification message for 'write' category", () => {
		expect(getSecurityNote("write")).toBe("This tool will modify files");
	});

	test("returns empty string for 'read' category", () => {
		expect(getSecurityNote("read")).toBe("");
	});

	test("returns empty string for undefined category", () => {
		expect(getSecurityNote(undefined)).toBe("");
	});

	test("returns empty string for unknown category", () => {
		expect(getSecurityNote("some-other-category")).toBe("");
	});
});
