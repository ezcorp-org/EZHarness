/**
 * DOM tests for ModesSection (custom modes settings):
 *   1. Built-in badge + tool-restriction chips render with the THEME
 *      TOKEN classes (locked decision 10 — the amber-on-dark chip was
 *      illegible; assert classes, not just text)
 *   2. Custom (non-builtin) rows get a Delete button, built-ins don't
 *   3. Delete flow — confirm() gate then DELETE /api/modes/{id}
 *   4. Extension-count chip, empty state
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ModesSection from "../settings/ModesSection.svelte";

type ModeRow = {
	id: string;
	name: string;
	description: string;
	icon?: string;
	builtin: boolean;
	toolRestriction: string;
	extensionIds?: string[];
	allowedTools?: string[];
};

interface FetchCall {
	url: string;
	method: string;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(getModes: () => ModeRow[], opts: { failDelete?: boolean } = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push({ url, method });
			if (method === "DELETE") {
				if (opts.failDelete) return Response.json({ error: "in use" }, { status: 409 });
				return new Response(null, { status: 204 });
			}
			if (url.includes("/api/extensions")) return Response.json([]); // modal picker
			if (method === "POST") return Response.json(getModes()[0] ?? {}); // created mode echo
			return Response.json(getModes());
		}),
	);
}

const makeMode = (overrides: Partial<ModeRow> = {}): ModeRow => ({
	id: "mode-1",
	name: "Focus",
	description: "Deep work mode",
	icon: "🎯",
	builtin: false,
	toolRestriction: "all",
	...overrides,
});

const THEME_CHIP_CLASSES = ["bg-[var(--color-surface-tertiary)]", "text-[var(--color-text-muted)]"];

afterEach(() => vi.unstubAllGlobals());

describe("ModesSection badges and chips", () => {
	test("built-in read-only mode renders both chips with theme-token classes", async () => {
		stubFetch(() => [
			makeMode({ id: "m-ro", name: "Plan", builtin: true, toolRestriction: "read-only" }),
		]);
		const { getByText } = render(ModesSection);

		await waitFor(() => expect(getByText("Plan")).toBeInTheDocument());
		const builtinChip = getByText("built-in");
		const restrictionChip = getByText("read-only");
		for (const cls of THEME_CHIP_CLASSES) {
			expect(builtinChip.className).toContain(cls);
			expect(restrictionChip.className).toContain(cls);
		}
	});

	test("built-in 'none' restriction renders the no-tools chip with theme tokens", async () => {
		stubFetch(() => [
			makeMode({ id: "m-nt", name: "Chat Only", builtin: true, toolRestriction: "none" }),
		]);
		const { getByText } = render(ModesSection);

		await waitFor(() => expect(getByText("no tools")).toBeInTheDocument());
		for (const cls of THEME_CHIP_CLASSES) {
			expect(getByText("no tools").className).toContain(cls);
		}
	});

	test("built-in 'allowlist' restriction shows the tool count instead of 'no tools'", async () => {
		stubFetch(() => [
			makeMode({
				id: "m-ez",
				name: "Ez",
				builtin: true,
				toolRestriction: "allowlist",
				allowedTools: ["a", "b", "c", "d", "e", "f", "g", "h"],
			}),
		]);
		const { getByText, queryByText } = render(ModesSection);

		await waitFor(() => expect(getByText("8 tools")).toBeInTheDocument());
		// The misleading legacy label must NOT render for allowlist modes.
		expect(queryByText("no tools")).not.toBeInTheDocument();
		for (const cls of THEME_CHIP_CLASSES) {
			expect(getByText("8 tools").className).toContain(cls);
		}
	});

	test("built-in 'allowlist' with no allowedTools shows '0 tools'", async () => {
		stubFetch(() => [
			makeMode({ id: "m-ez0", name: "Ez", builtin: true, toolRestriction: "allowlist" }),
		]);
		const { getByText } = render(ModesSection);
		await waitFor(() => expect(getByText("0 tools")).toBeInTheDocument());
	});

	test("built-in with toolRestriction 'all' shows no restriction chip", async () => {
		stubFetch(() => [makeMode({ id: "m-all", name: "Ez", builtin: true, toolRestriction: "all" })]);
		const { getByText, queryByText } = render(ModesSection);

		await waitFor(() => expect(getByText("built-in")).toBeInTheDocument());
		expect(queryByText("read-only")).not.toBeInTheDocument();
		expect(queryByText("no tools")).not.toBeInTheDocument();
	});

	test("extension-count chip pluralizes", async () => {
		stubFetch(() => [
			makeMode({ id: "m-1", name: "One", extensionIds: ["e1"] }),
			makeMode({ id: "m-2", name: "Two", extensionIds: ["e1", "e2"] }),
		]);
		const { getByText } = render(ModesSection);

		await waitFor(() => expect(getByText("1 extension")).toBeInTheDocument());
		expect(getByText("2 extensions")).toBeInTheDocument();
	});
});

describe("ModesSection custom mode rows", () => {
	test("custom mode shows name, description, and a Delete button; built-in does not", async () => {
		stubFetch(() => [
			makeMode({ id: "m-custom", name: "Focus", builtin: false }),
			makeMode({ id: "m-builtin", name: "Ez", description: "Built-in assistant", builtin: true }),
		]);
		const { getByText, getAllByText, queryAllByText } = render(ModesSection);

		await waitFor(() => expect(getByText("Focus")).toBeInTheDocument());
		expect(getByText("Deep work mode")).toBeInTheDocument();
		// Exactly ONE delete button — only the custom row gets one.
		expect(queryAllByText("Delete")).toHaveLength(1);
		expect(getAllByText("built-in")).toHaveLength(1);
	});

	test("empty state renders the seeding hint", async () => {
		stubFetch(() => []);
		const { getByText } = render(ModesSection);
		await waitFor(() =>
			expect(getByText(/No modes yet/)).toBeInTheDocument(),
		);
	});
});

describe("ModesSection delete flow", () => {
	test("confirmed delete fires DELETE /api/modes/{id} and refetches", async () => {
		vi.stubGlobal("confirm", vi.fn(() => true));
		let modes = [makeMode({ id: "m-del", name: "Doomed" })];
		stubFetch(() => modes);
		const { getByText, queryByText } = render(ModesSection);
		await waitFor(() => expect(getByText("Doomed")).toBeInTheDocument());

		modes = [];
		await fireEvent.click(getByText("Delete"));

		await waitFor(() => {
			const del = fetchCalls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.url).toContain("/api/modes/m-del");
		});
		await waitFor(() => expect(queryByText("Doomed")).not.toBeInTheDocument());
	});

	test("declined confirm() leaves the mode untouched", async () => {
		vi.stubGlobal("confirm", vi.fn(() => false));
		stubFetch(() => [makeMode({ id: "m-keep", name: "Keeper" })]);
		const { getByText } = render(ModesSection);
		await waitFor(() => expect(getByText("Keeper")).toBeInTheDocument());

		await fireEvent.click(getByText("Delete"));

		expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
		expect(getByText("Keeper")).toBeInTheDocument();
	});

	test("failed DELETE surfaces the API error via alert()", async () => {
		vi.stubGlobal("confirm", vi.fn(() => true));
		const alertSpy = vi.fn();
		vi.stubGlobal("alert", alertSpy);
		stubFetch(() => [makeMode({ id: "m-stuck", name: "Stuck" })], { failDelete: true });
		const { getByText } = render(ModesSection);
		await waitFor(() => expect(getByText("Stuck")).toBeInTheDocument());

		await fireEvent.click(getByText("Delete"));

		await waitFor(() => expect(alertSpy).toHaveBeenCalled());
		expect(getByText("Stuck")).toBeInTheDocument();
	});
});

describe("ModesSection modal wiring", () => {
	test("Create Mode opens the modal; a successful save closes it and refetches", async () => {
		let modes: ModeRow[] = [];
		stubFetch(() => modes);
		const { getByText, getAllByRole, getByLabelText, queryByLabelText, getByPlaceholderText, container } =
			render(ModesSection);
		await waitFor(() => expect(getByText(/No modes yet/)).toBeInTheDocument());

		await fireEvent.click(getByText("Create Mode"));
		await waitFor(() => expect(getByLabelText("Create Mode")).toBeInTheDocument()); // dialog

		// Fill the required fields (slug auto-derives from the name).
		await fireEvent.input(getByPlaceholderText("e.g. Debug"), { target: { value: "Focus" } });
		await fireEvent.input(
			container.querySelector("#mode-form-system-prompt")!,
			{ target: { value: "Stay focused." } },
		);

		modes = [makeMode({ id: "m-new", name: "Focus" })];
		// Two "Create Mode" buttons now (section action + modal submit) —
		// the submit is the last one.
		const buttons = getAllByRole("button", { name: "Create Mode" });
		await fireEvent.click(buttons[buttons.length - 1]!);

		await waitFor(() => expect(queryByLabelText("Create Mode")).not.toBeInTheDocument());
		await waitFor(() => expect(getByText("Focus")).toBeInTheDocument());
		expect(fetchCalls.filter((c) => c.method === "GET" && c.url.includes("/api/modes"))).toHaveLength(2);
	});

	test("clicking a mode row opens the view modal", async () => {
		stubFetch(() => [makeMode({ id: "m-view", name: "Focus" })]);
		const { getByLabelText, queryByLabelText } = render(ModesSection);
		await waitFor(() => expect(getByLabelText("View Focus mode")).toBeInTheDocument());
		expect(queryByLabelText("View Mode")).not.toBeInTheDocument();

		await fireEvent.click(getByLabelText("View Focus mode"));

		await waitFor(() => expect(getByLabelText("View Mode")).toBeInTheDocument()); // dialog title
	});
});
