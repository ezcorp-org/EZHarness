/**
 * DOM tests for SystemHealth (locked decision 9 — no silent-empty
 * state): the card always renders loading, error, or the status list.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import SystemHealth from "../settings/SystemHealth.svelte";

function stubHealth(responder: () => Response | Promise<Response>) {
	vi.stubGlobal("fetch", vi.fn(async () => responder()));
}

afterEach(() => vi.unstubAllGlobals());

const healthy = {
	status: "healthy",
	db: { status: "up" },
	embeddings: { status: "ready" },
	providers: { anthropic: { status: "configured" }, openai: { status: "not_configured" } },
};

describe("SystemHealth", () => {
	test("shows loading first, then the status list", async () => {
		let release!: (r: Response) => void;
		const pending = new Promise<Response>((r) => {
			release = r;
		});
		stubHealth(() => pending);
		const { getByTestId, getByText } = render(SystemHealth);

		expect(getByTestId("health-loading")).toBeInTheDocument();

		release(Response.json(healthy));
		await waitFor(() => {
			expect(getByText("Database")).toBeInTheDocument();
		});
		expect(getByText("Embeddings")).toBeInTheDocument();
		expect(getByText("anthropic")).toBeInTheDocument();
		expect(getByText("healthy")).toBeInTheDocument();
	});

	test("non-ok response (500) renders the error state — the old silent-empty bug", async () => {
		stubHealth(() => new Response("oops", { status: 500 }));
		const { getByTestId } = render(SystemHealth);

		await waitFor(() => {
			expect(getByTestId("health-error")).toBeInTheDocument();
		});
	});

	test("401 renders the error state", async () => {
		stubHealth(() => new Response("{}", { status: 401 }));
		const { getByTestId } = render(SystemHealth);

		await waitFor(() => {
			expect(getByTestId("health-error")).toBeInTheDocument();
		});
	});

	test("network failure renders the error state", async () => {
		stubHealth(() => Promise.reject(new Error("offline")));
		const { getByTestId } = render(SystemHealth);

		await waitFor(() => {
			expect(getByTestId("health-error")).toBeInTheDocument();
		});
	});
});
