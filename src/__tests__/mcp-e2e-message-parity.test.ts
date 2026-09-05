/**
 * Lockstep guard between the uniform MCP failure message and the string the
 * Playwright spec asserts an admin SEES.
 *
 * `web/e2e/extensions-mcp-edit.spec.ts` cannot import
 * `MCP_CATALOG_PROBE_FAILED_MESSAGE`: it `page.route`-fulfils its own failure body, so
 * it necessarily hand-copies the text. That decoupling was measured — a
 * reviewer changed the source constant and the spec still passed 6/6, because
 * the mock and the assertion were both edited from the same stale literal.
 *
 * So the spec's literal is PARSED here and compared to the real constant. The
 * spec file is read as text rather than imported for two reasons: it is a
 * Playwright module (its `test` fixture pulls in the browser harness), and
 * the repo's lcov merge trap forbids a `src/` bun test from importing a
 * `web/src/lib/**` module — parsing sidesteps both. Same technique as
 * `author-draft-allowlist-parity.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_CATALOG_PROBE_FAILED_MESSAGE } from "../mcp/connect-failure";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SPEC_PATH = join(REPO_ROOT, "web", "e2e", "extensions-mcp-edit.spec.ts");

/**
 * Pull the `PROBE_FAILURE` literal out of the spec. It is written as an
 * adjacent-string concatenation to stay inside the line-length limit, so
 * collect every quoted chunk of the initializer and join them.
 */
function readSpecLiteral(): string {
	const src = readFileSync(SPEC_PATH, "utf8");
	const match = src.match(/const\s+PROBE_FAILURE\s*=\s*([\s\S]*?);\n/);
	if (!match) throw new Error(`PROBE_FAILURE not found in ${SPEC_PATH}`);
	const chunks = [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
		m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
	);
	if (chunks.length === 0) throw new Error("PROBE_FAILURE has no string chunks");
	return chunks.join("");
}

describe("e2e failure message stays in lockstep with the source constant", () => {
	test("the spec asserts exactly the production catalog probe failure", () => {
		expect(readSpecLiteral()).toBe(MCP_CATALOG_PROBE_FAILED_MESSAGE);
	});

	test("the spec does not hardcode the message anywhere else", () => {
		// A second copy would drift independently of the one this test pins.
		const src = readFileSync(SPEC_PATH, "utf8");
		const occurrences = src.split("MCP catalog probe failed").length - 1;
		expect(occurrences).toBe(1);
	});
});
