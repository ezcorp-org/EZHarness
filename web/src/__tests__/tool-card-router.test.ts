import { test, expect, describe } from "bun:test";
import { getCardComponentName } from "../lib/components/tool-cards/utils.js";

describe("getCardComponentName", () => {
	test("maps 'terminal' cardType to TerminalCard", () => {
		expect(getCardComponentName("terminal", false)).toBe("TerminalCard");
	});

	test("maps 'diff' cardType to DiffCard", () => {
		expect(getCardComponentName("diff", false)).toBe("DiffCard");
	});

	test("maps 'search-results' cardType to SearchResultsCard", () => {
		expect(getCardComponentName("search-results", false)).toBe("SearchResultsCard");
	});

	test("maps unknown cardType to DefaultCard", () => {
		expect(getCardComponentName("unknown-type", false)).toBe("DefaultCard");
	});

	test("maps undefined cardType to DefaultCard", () => {
		expect(getCardComponentName(undefined, false)).toBe("DefaultCard");
	});

	test("returns PermissionGate when permissionPending is true regardless of cardType", () => {
		expect(getCardComponentName("terminal", true)).toBe("PermissionGate");
		expect(getCardComponentName("diff", true)).toBe("PermissionGate");
		expect(getCardComponentName(undefined, true)).toBe("PermissionGate");
	});

	test("returns card component when permissionPending is undefined", () => {
		expect(getCardComponentName("terminal", undefined)).toBe("TerminalCard");
	});
});
