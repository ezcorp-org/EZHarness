/**
 * Tests for `cardLayout` manifest validation behavior.
 *
 * Per canvas-dock-sdk.md §5 unit cases #manifest:
 *   - A manifest with `cardLayout: "dock"` parses cleanly (no validation
 *     errors raised).
 *   - A manifest with `cardLayout: "garbage"` is tolerated by the
 *     manifest validator (forward-compat: unknown values don't break
 *     install). The runtime emit-side normalizes them to undefined +
 *     warns — see subscribe-bridge.ts `normalizeCardLayout`.
 */
import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";

const baseValidManifest = {
	schemaVersion: 2,
	name: "test-ext",
	version: "1.0.0",
	description: "Test",
	author: { name: "Tester" },
	entrypoint: "index.ts",
};

describe("validateManifestV2 — cardLayout", () => {
	test('manifest with cardLayout: "dock" parses without errors', () => {
		const manifest = {
			...baseValidManifest,
			tools: [
				{
					name: "open-canvas",
					description: "Open the canvas",
					inputSchema: { type: "object", properties: {} },
					cardType: "design-canvas",
					cardLayout: "dock",
				},
			],
		};
		const result = validateManifestV2(manifest);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('manifest with unknown cardLayout value is tolerated (forward-compat)', () => {
		// The manifest validator does not enforce the cardLayout enum — that
		// is the host's job at the runtime emit / lookup site, where it
		// normalizes to undefined and warns. This keeps install resilient
		// to typos and future-tier values: an extension built against
		// a newer host version with extra cardLayout values still installs
		// cleanly on an older host (just renders inline).
		const manifest = {
			...baseValidManifest,
			tools: [
				{
					name: "open-canvas",
					description: "Open the canvas",
					inputSchema: { type: "object" },
					cardLayout: "garbage",
				},
			],
		};
		const result = validateManifestV2(manifest);
		expect(result.valid).toBe(true);
	});
});
