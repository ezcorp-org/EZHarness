import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The workspace has its own suite; here it is a probe that shows the props the
// page passed, so these tests read the page's own choices.
const { store, setActiveProjectId, pageState, goto } = vi.hoisted(() => ({
	store: { projects: [] as { id: string; name: string }[], activeProjectId: "global" },
	setActiveProjectId: vi.fn(),
	pageState: { url: new URL("http://localhost/factories") },
	goto: vi.fn(async (_url: URL | string, _options?: Record<string, unknown>) => undefined),
}));

vi.mock("$lib/stores.svelte.js", () => ({ store, setActiveProjectId }));
vi.mock("$app/state", () => ({ page: pageState }));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("$lib/factory/FactoryWorkspace.svelte", async () => ({ default: (await import("../../../__tests__/stubs/FactoryPropsProbe.svelte")).default }));

const { default: FactoriesPage } = await import("./+page.svelte");

type Probe = Record<string, string | undefined>;
function probe(): Probe {
	return { ...screen.getByTestId("factory-props-probe").dataset };
}

const project = (id: string) => ({ id, name: id });
let me: () => Promise<Response>;

function renderPage(url = "http://localhost/factories", data = { tenantId: "tenant-1", administrator: false }) {
	pageState.url = new URL(url);
	return render(FactoriesPage, { props: { data } as never });
}

beforeEach(() => {
	setActiveProjectId.mockClear();
	goto.mockClear();
	store.projects = [project("global"), project("project-a"), project("project-b")];
	store.activeProjectId = "global";
	me = async () => new Response("{}", { status: 401 });
	vi.stubGlobal("fetch", vi.fn(async (input: string) => {
		expect(input).toBe("/api/auth/me");
		return me();
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe("/factories page", () => {
	test("passes the active project, the URL's view and run, the tenant, and the server's admin answer", () => {
		store.activeProjectId = "project-b";
		renderPage("http://localhost/factories?view=runs&run=run%2F7", { tenantId: "tenant-1", administrator: true });
		expect(probe()).toMatchObject({
			projectId: "project-b",
			projects: "project-a,project-b",
			view: "runs",
			runId: "run/7",
			tenantId: "tenant-1",
			administrator: "true",
			currentUserId: "none",
		});
		expect(document.title).toBe("Factories — EZHarness");
	});

	test("an unknown view in the URL falls back to authoring", () => {
		renderPage("http://localhost/factories?view=everything");
		expect(probe().view).toBe("authoring");
	});

	test("falls back to the first real project, and to none when only the global project exists", () => {
		renderPage();
		expect(probe().projectId).toBe("project-a");
		store.projects = [project("global")];
		document.body.innerHTML = "";
		renderPage();
		expect(probe()).toMatchObject({ projectId: "", projects: "" });
	});

	test("a project change sets the active project once", async () => {
		renderPage();
		await fireEvent.click(screen.getByRole("button", { name: "choose project-b" }));
		expect(setActiveProjectId).toHaveBeenCalledWith("project-b");
		expect(setActiveProjectId).toHaveBeenCalledTimes(1);
	});

	test("the session's own record confirms or withdraws the admin answer and names the user", async () => {
		me = async () => Response.json({ user: { id: "user-1", role: "admin" } });
		renderPage("http://localhost/factories", { tenantId: "tenant-1", administrator: false });
		await waitFor(() => expect(probe()).toMatchObject({ administrator: "true", currentUserId: "user-1" }));
		document.body.innerHTML = "";

		me = async () => Response.json({ user: { id: "user-2", role: "member" } });
		renderPage("http://localhost/factories", { tenantId: "tenant-1", administrator: true });
		await waitFor(() => expect(probe()).toMatchObject({ administrator: "false", currentUserId: "user-2" }));
	});

	test("without a session record the server's answer stands", async () => {
		for (const reply of [
			async () => new Response("{}", { status: 401 }),
			async () => Response.json({}),
			async () => { throw new Error("offline"); },
		]) {
			me = reply;
			document.body.innerHTML = "";
			renderPage("http://localhost/factories", { tenantId: "tenant-1", administrator: true });
			await waitFor(() => expect(fetch).toHaveBeenCalled());
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(probe()).toMatchObject({ administrator: "true", currentUserId: "none" });
			vi.mocked(fetch).mockClear();
		}
	});

	test("changing the view rewrites the URL: authoring clears view and run, a run opens in runs", async () => {
		renderPage("http://localhost/factories?view=inbox&run=old&keep=1");
		await fireEvent.click(screen.getByRole("button", { name: "view runs" }));
		await fireEvent.click(screen.getByRole("button", { name: "view authoring" }));
		await fireEvent.click(screen.getByRole("button", { name: "open run/1" }));
		const options = { keepFocus: true, noScroll: true, replaceState: false };
		expect(goto.mock.calls.map(([url, opts]) => [String(url), opts])).toEqual([
			["http://localhost/factories?view=runs&keep=1", options],
			["http://localhost/factories?keep=1", options],
			// goto is mocked, so each change starts from the same URL; the run replaces run=old in place.
			["http://localhost/factories?view=runs&run=run%2F1&keep=1", options],
		]);
	});
});
