/**
 * DOM tests for AuthorCompositionPanel (Phase 4 §5.3).
 *
 *   - capability toggle → onsave with config source carrying
 *     permissions.search = "inherit" (and toggling off removes it)
 *   - "Use other extensions" picker → onsave with manifest.dependencies
 *     written from the picked extension (name+version)
 *   - unresolved-dependency warning shows when a declared dep isn't in the
 *     installed set (non-fatal)
 *   - an unrecognized config disables the panel (hand-edit message)
 *
 * Both this panel AND the embedded ExtensionAttachPicker fetch
 * /api/extensions on mount — one stub serves both.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";
import AuthorCompositionPanel from "../extensions/AuthorCompositionPanel.svelte";
import { parseCapabilities, parseDependencies } from "$lib/ezcorp-config-edit.js";

const SCAFFOLD = `import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "my-ext",
  version: "0.1.0",
  description: "x",
  author: { name: "Me" },
  entrypoint: "./index.ts",
  tools: [],
  permissions: {},
});
`;

const INSTALLED = [
	{ id: "ext-ai-kit", name: "ai-kit", version: "0.1.0", manifest: { tools: [] } },
	{ id: "ext-web-search", name: "web-search", version: "1.0.0", manifest: { tools: [] } },
];

function stubExtensions(list = INSTALLED) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/extensions")) return Response.json(list);
			return Response.json({});
		}),
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("AuthorCompositionPanel — recognized config", () => {
	test("renders capability toggles + the Use-other-extensions affordance", async () => {
		stubExtensions();
		const { getByTestId } = render(AuthorCompositionPanel, {
			props: { source: SCAFFOLD, onsave: vi.fn(async () => {}) },
		});
		expect(getByTestId("author-composition-panel")).toBeInTheDocument();
		expect(getByTestId("author-capability-search")).toBeInTheDocument();
		expect(getByTestId("author-use-extensions-open")).toBeInTheDocument();
		expect(getByTestId("author-deps-empty")).toBeInTheDocument();
	});

	test("toggling Search ON saves a config with permissions.search = inherit", async () => {
		stubExtensions();
		let saved = "";
		const onsave = vi.fn(async (next: string) => {
			saved = next;
		});
		const { getByTestId } = render(AuthorCompositionPanel, { props: { source: SCAFFOLD, onsave } });

		expect(getByTestId("author-capability-search").getAttribute("aria-checked")).toBe("false");
		await fireEvent.click(getByTestId("author-capability-search"));

		await waitFor(() => expect(onsave).toHaveBeenCalled());
		expect(parseCapabilities(saved)).toEqual({ search: true, memory: false, llm: false });
	});

	test("toggling an already-on capability OFF removes it", async () => {
		stubExtensions();
		const onWith = SCAFFOLD.replace("permissions: {}", `permissions: {\n    search: "inherit",\n  }`);
		let saved = "";
		const onsave = vi.fn(async (next: string) => {
			saved = next;
		});
		const { getByTestId } = render(AuthorCompositionPanel, { props: { source: onWith, onsave } });

		expect(getByTestId("author-capability-search").getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(getByTestId("author-capability-search"));

		await waitFor(() => expect(onsave).toHaveBeenCalled());
		expect(parseCapabilities(saved).search).toBe(false);
	});

	test("an OBJECT-valued (custom ceiling) cap is READ-ONLY: toggle disabled + warning, no save/corruption", async () => {
		stubExtensions();
		const objectCap = SCAFFOLD.replace(
			"permissions: {}",
			`permissions: {\n    search: { quota: 500, maxResults: 10 },\n  }`,
		);
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(AuthorCompositionPanel, { props: { source: objectCap, onsave } });

		// Search shows ON (object = granted) but the toggle is LOCKED.
		expect(getByTestId("author-capability-search").getAttribute("aria-checked")).toBe("true");
		expect(getByTestId("author-capability-search")).toBeDisabled();
		expect(getByTestId("author-capability-unmanaged-warning")).toHaveTextContent("search");

		// Forcing a click is a no-op — never persists (can't corrupt/widen).
		await fireEvent.click(getByTestId("author-capability-search"));
		expect(onsave).not.toHaveBeenCalled();

		// An UNMANAGED cap doesn't lock the OTHER toggles.
		expect(getByTestId("author-capability-memory")).not.toBeDisabled();
	});

	test("picking an extension writes manifest.dependencies (name + caret version)", async () => {
		stubExtensions();
		let saved = "";
		const onsave = vi.fn(async (next: string) => {
			saved = next;
		});
		const { getByTestId } = render(AuthorCompositionPanel, { props: { source: SCAFFOLD, onsave } });

		// Open the picker, select ai-kit, submit.
		await fireEvent.click(getByTestId("author-use-extensions-open"));
		await waitFor(() => expect(getByTestId("extension-attach-picker")).toBeInTheDocument());
		// Wait for the picker's own /api/extensions load to populate cards.
		await waitFor(() => expect(getByTestId("extension-attach-picker-submit")).toBeInTheDocument());

		const card = await waitFor(() => {
			const c = document.querySelector('[data-testid="extension-attach-picker-card"][data-ext-id="ext-ai-kit"]');
			if (!c) throw new Error("card not yet rendered");
			return c as HTMLElement;
		});
		await fireEvent.click(card.querySelector("button")!);
		await fireEvent.click(getByTestId("extension-attach-picker-submit"));

		await waitFor(() => expect(onsave).toHaveBeenCalled());
		expect(parseDependencies(saved)).toEqual([{ name: "ai-kit", source: "bundled", version: "^0.1.0" }]);
	});

	test("a failed save flashes the error", async () => {
		stubExtensions();
		const onsave = vi.fn(async () => {
			throw new Error("save boom");
		});
		const { getByTestId } = render(AuthorCompositionPanel, { props: { source: SCAFFOLD, onsave } });
		await fireEvent.click(getByTestId("author-capability-memory"));
		await waitFor(() => expect(getByTestId("author-composition-error")).toBeInTheDocument());
	});

	test("unresolved-dependency warning shows for a declared dep absent from the installed set", async () => {
		// Installed set has only web-search; the config declares ghost-ext.
		stubExtensions([{ id: "ext-web-search", name: "web-search", version: "1.0.0", manifest: { tools: [] } }]);
		const ghostConfig = SCAFFOLD.replace(
			"  permissions: {}",
			`  // ezcorp:dependencies (managed)\n  dependencies: {\n    "ghost-ext": { source: "bundled", version: "1.0.0" },\n  },\n  // ezcorp:dependencies:end\n  permissions: {}`,
		);
		const { getByTestId } = render(AuthorCompositionPanel, {
			props: { source: ghostConfig, onsave: vi.fn(async () => {}) },
		});
		await waitFor(() => expect(getByTestId("author-unresolved-warning")).toBeInTheDocument());
		expect(getByTestId("author-unresolved-warning")).toHaveTextContent("ghost-ext");
	});
});

describe("AuthorCompositionPanel — unrecognized config", () => {
	test("disables itself with a hand-edit message", () => {
		stubExtensions();
		const { getByTestId, queryByTestId } = render(AuthorCompositionPanel, {
			props: { source: "export const x = 1;", onsave: vi.fn(async () => {}) },
		});
		expect(getByTestId("author-composition-unrecognized")).toBeInTheDocument();
		expect(queryByTestId("author-capability-toggles")).toBeNull();
		expect(queryByTestId("author-use-extensions-open")).toBeNull();
	});
});
