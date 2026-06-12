/**
 * DOM tests for ApiKeyManager (developer settings):
 *   1. Create — POST carries name + selected scopes; reveal banner
 *   2. Copy flow — clipboard write + Copied! flash + revert; Dismiss
 *   3. Revoke — inline confirmation, DELETE { keyId }, cancel path
 *   4. Empty / loading states, scope toggling, create error path
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ApiKeyManager from "../settings/ApiKeyManager.svelte";

type KeyEntry = { keyId: string; name: string; scopes: string[]; createdAt: number };

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(opts: { keys?: () => KeyEntry[]; createdKey?: string; failCreate?: boolean } = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (method === "POST") {
				if (opts.failCreate) return Response.json({ error: "boom" }, { status: 500 });
				return Response.json({ key: opts.createdKey ?? "ezc_live_secret" });
			}
			if (method === "DELETE") return new Response(null, { status: 204 });
			return Response.json({ keys: opts.keys?.() ?? [] });
		}),
	);
}

function stubClipboard() {
	const writeText = vi.fn();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	return writeText;
}

const makeKey = (overrides: Partial<KeyEntry> = {}): KeyEntry => ({
	keyId: "key-1",
	name: "CI Pipeline",
	scopes: ["read", "chat"],
	createdAt: Date.parse("2026-06-01T00:00:00.000Z"),
	...overrides,
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("ApiKeyManager create", () => {
	test("posts name + selected scopes and reveals the key once", async () => {
		let keys: KeyEntry[] = [];
		stubFetch({ keys: () => keys, createdKey: "ezc_live_abc123" });
		const { getByText, getByLabelText, getByRole } = render(ApiKeyManager);
		await waitFor(() => expect(getByText("No API keys yet.")).toBeInTheDocument());

		await fireEvent.input(getByLabelText("Name"), { target: { value: "  CI Pipeline  " } });
		await fireEvent.click(getByText("chat")); // "read" is preselected
		keys = [makeKey()];
		await fireEvent.click(getByRole("button", { name: "Create API Key" }));

		await waitFor(() => {
			const post = fetchCalls.find((c) => c.method === "POST");
			expect(post).toBeTruthy();
			expect(post!.url).toContain("/api/settings/developer/api-keys");
			expect(post!.body).toEqual({ name: "CI Pipeline", scopes: ["read", "chat"] });
		});
		await waitFor(() =>
			expect(getByText("This key will only be shown once. Copy it now.")).toBeInTheDocument(),
		);
		expect(getByText("ezc_live_abc123")).toBeInTheDocument();
	});

	test("create button disabled with a blank name or zero scopes", async () => {
		stubFetch();
		const { getByText, getByLabelText, getByRole } = render(ApiKeyManager);
		await waitFor(() => expect(getByText("No API keys yet.")).toBeInTheDocument());

		const createBtn = getByRole("button", { name: "Create API Key" });
		expect(createBtn).toBeDisabled(); // blank name

		await fireEvent.input(getByLabelText("Name"), { target: { value: "k" } });
		expect(createBtn).not.toBeDisabled();

		await fireEvent.click(getByText("read")); // toggle the only scope off
		expect(createBtn).toBeDisabled();
	});

	test("failed POST shows no reveal banner", async () => {
		stubFetch({ failCreate: true });
		const { getByText, getByLabelText, queryByText, getByRole } = render(ApiKeyManager);
		await waitFor(() => expect(getByText("No API keys yet.")).toBeInTheDocument());

		await fireEvent.input(getByLabelText("Name"), { target: { value: "Doomed" } });
		await fireEvent.click(getByRole("button", { name: "Create API Key" }));

		await waitFor(() => expect(fetchCalls.some((c) => c.method === "POST")).toBe(true));
		expect(queryByText(/shown once/)).not.toBeInTheDocument();
	});
});

describe("ApiKeyManager reveal + copy", () => {
	async function createAndReveal() {
		const writeText = stubClipboard();
		stubFetch({ createdKey: "ezc_live_xyz" });
		const utils = render(ApiKeyManager);
		await vi.advanceTimersByTimeAsync(0); // flush mount fetch
		await fireEvent.input(utils.getByLabelText("Name"), { target: { value: "k" } });
		await fireEvent.click(utils.getByRole("button", { name: "Create API Key" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(utils.getByText("ezc_live_xyz")).toBeInTheDocument();
		return { writeText, ...utils };
	}

	test("Copy writes the revealed key, flashes Copied!, then reverts", async () => {
		vi.useFakeTimers();
		const { writeText, getByText } = await createAndReveal();

		await fireEvent.click(getByText("Copy"));
		expect(writeText).toHaveBeenCalledWith("ezc_live_xyz");
		expect(getByText("Copied!")).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(2000);
		expect(getByText("Copy")).toBeInTheDocument();
	});

	test("Dismiss hides the reveal banner", async () => {
		vi.useFakeTimers();
		const { getByText, queryByText } = await createAndReveal();

		await fireEvent.click(getByText("Dismiss"));
		expect(queryByText("ezc_live_xyz")).not.toBeInTheDocument();
	});
});

describe("ApiKeyManager revoke", () => {
	test("Revoke shows an inline confirmation; Yes, revoke DELETEs the keyId and refetches", async () => {
		let keys = [makeKey({ keyId: "key-9", name: "Old Key" })];
		stubFetch({ keys: () => keys });
		const { getByText, queryByText } = render(ApiKeyManager);
		await waitFor(() => expect(getByText("Old Key")).toBeInTheDocument());

		await fireEvent.click(getByText("Revoke"));
		expect(getByText("Confirm?")).toBeInTheDocument();

		keys = [];
		await fireEvent.click(getByText("Yes, revoke"));

		await waitFor(() => {
			const del = fetchCalls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.body).toEqual({ keyId: "key-9" });
		});
		await waitFor(() => expect(queryByText("Old Key")).not.toBeInTheDocument());
	});

	test("Cancel dismisses the confirmation without a DELETE", async () => {
		stubFetch({ keys: () => [makeKey()] });
		const { getByText, queryByText } = render(ApiKeyManager);
		await waitFor(() => expect(getByText("CI Pipeline")).toBeInTheDocument());

		await fireEvent.click(getByText("Revoke"));
		await fireEvent.click(getByText("Cancel"));

		expect(queryByText("Confirm?")).not.toBeInTheDocument();
		expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
	});
});

describe("ApiKeyManager rendering states", () => {
	test("shows Loading... before the fetch resolves", async () => {
		stubFetch();
		const { getByText } = render(ApiKeyManager);
		expect(getByText("Loading...")).toBeInTheDocument();
		await waitFor(() => expect(getByText("No API keys yet.")).toBeInTheDocument());
	});

	test("lists key name, scope pills, and created date", async () => {
		const key = makeKey();
		stubFetch({ keys: () => [key] });
		const { getByText, getAllByText } = render(ApiKeyManager);

		await waitFor(() => expect(getByText("CI Pipeline")).toBeInTheDocument());
		// "read"/"chat" appear both as list pills and as create-form scope
		// buttons — the pill is the <span>, the form one is a <button>.
		expect(getAllByText("read").some((el) => el.tagName === "SPAN")).toBe(true);
		expect(getAllByText("chat").some((el) => el.tagName === "SPAN")).toBe(true);
		expect(getByText(new Date(key.createdAt).toLocaleDateString())).toBeInTheDocument();
	});
});
