/**
 * Page-integration test for the extension AUTHOR draft page
 * (`author/+page.svelte`) — Phase 4 §5.3 mount + save wiring.
 *
 * No SSR / no Docker: renders the page component with a `data` prop and
 * asserts the new AuthorCompositionPanel MOUNTS (gated on the config file
 * being present) and that a capability toggle round-trips through the
 * page's real `onCompositionSave` → file-map merge → `saveFile` (the
 * draft PUT). The mount-GUARD negative (no config file → no panel) is
 * covered too. The component's own logic is exercised in
 * AuthorCompositionPanel.component.test.ts; this proves the page wiring.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

import AuthorPage from "../+page.svelte";
import { parseCapabilities } from "$lib/ezcorp-config-edit.js";

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

interface PutCall {
	url: string;
	body: { path?: string; content?: string };
}
let putCalls: PutCall[] = [];

function stubFetch() {
	putCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			// The composition panel + embedded picker load /api/extensions.
			if (url.includes("/api/extensions") && !url.includes("/draft/")) {
				return Response.json([]);
			}
			// saveFile → PUT /api/extensions/author/draft/[id]
			if (method === "PUT" && url.includes("/author/draft/")) {
				putCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
				return Response.json({ ok: true });
			}
			return Response.json({});
		}),
	);
}

function pageData(files: Record<string, string>) {
	return {
		draft: { id: "draft-1", kind: "extension", payload: { name: "my-ext", type: "tool" }, createdAt: 0, expiresAt: 0, consumedAt: null },
		files,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("author page — composition panel wiring", () => {
	test("mounts the composition panel when the config file is present", async () => {
		stubFetch();
		const { getByTestId } = render(AuthorPage, { props: { data: pageData({ "ezcorp.config.ts": SCAFFOLD }) } });
		expect(getByTestId("author-composition-panel")).toBeInTheDocument();
		expect(getByTestId("author-capability-search")).toBeInTheDocument();
	});

	test("a capability toggle round-trips through onCompositionSave → saveFile (draft PUT)", async () => {
		stubFetch();
		const { getByTestId } = render(AuthorPage, { props: { data: pageData({ "ezcorp.config.ts": SCAFFOLD }) } });

		await fireEvent.click(getByTestId("author-capability-search"));

		// The page's onCompositionSave merged the new source into `files`
		// and PUT it to the draft endpoint.
		await waitFor(() => expect(putCalls.length).toBeGreaterThanOrEqual(1));
		const put = putCalls.find((c) => c.body.path === "ezcorp.config.ts");
		expect(put).toBeTruthy();
		expect(put!.url).toContain("/api/extensions/author/draft/draft-1");
		expect(parseCapabilities(put!.body.content ?? "")).toEqual({ search: true, memory: false, llm: false });
	});

	test("mount GUARD: no config file → panel absent", () => {
		stubFetch();
		const { queryByTestId } = render(AuthorPage, { props: { data: pageData({ "index.ts": "// code" }) } });
		expect(queryByTestId("author-composition-panel")).toBeNull();
	});
});
