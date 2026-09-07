/**
 * Integration component test for the onboarding wizard at /onboarding.
 *
 * Covers the user-visible logic of the 3-step stepper:
 *   - Step 1 starts visible with the stub provider section
 *   - data.hasProvider=true → "Provider already connected" banner shows
 *   - Step 1 "Continue" is disabled when no provider connected (and
 *     hasProvider=false), enabled when hasProvider=true
 *   - Step 1 "Skip for now" advances to Step 2
 *   - Step 2: default selection is "balanced"; selecting "quality"
 *     triggers upsertSetting('provider:defaultTier', 'quality') on
 *     Continue
 *   - Step 2: skip does NOT call upsertSetting
 *   - Step 3: "Get started" POSTs /api/onboarding/complete and navigates to /
 *
 * The real ProviderSettings is mocked with a pass-through stub so its
 * network calls don't pollute the fetch spy. The actual provider-connect
 * flow (real ProviderSettings → fetch /api/providers → status arrives →
 * Continue enables) is exercised by the Playwright e2e specs.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/components/ProviderSettings.svelte", async () => {
	const stub = await import("./fixtures/ProviderSettingsStub.svelte");
	return { default: stub.default };
});
vi.mock("$lib/api.js", () => ({
	upsertSetting: vi.fn(async () => {}),
}));

import OnboardingPage from "../routes/(auth)/onboarding/+page.svelte";
import { upsertSetting } from "$lib/api.js";

const baseUser = { id: "u-1", name: "Ada", email: "ada@test.com", role: "admin" as const };

describe("Onboarding wizard (+page.svelte)", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let originalLocation: Location;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 204 }),
		);
		vi.mocked(upsertSetting).mockReset();
		vi.mocked(upsertSetting).mockResolvedValue(undefined);
		originalLocation = window.location;
		Object.defineProperty(window, "location", {
			value: { href: "" },
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		Object.defineProperty(window, "location", {
			value: originalLocation,
			writable: true,
			configurable: true,
		});
	});

	test("member sees completable guidance instead of provider and tier writes", () => {
		const { getByTestId, queryByTestId } = render(OnboardingPage, {
			data: { user: { ...baseUser, role: "member" as const }, hasProvider: false },
		});

		expect(getByTestId("member-provider-guidance")).toBeInTheDocument();
		expect(queryByTestId("provider-settings-stub")).toBeNull();
	});

	test("renders Step 1 first with the welcome name and stepper at 1", () => {
		const { getByText, getByLabelText } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: false },
		});
		expect(getByText("Welcome, Ada")).toBeInTheDocument();
		expect(getByText("Connect a provider")).toBeInTheDocument();
		expect(getByLabelText("Onboarding progress")).toBeInTheDocument();
	});

	test("data.hasProvider=true → 'already connected' banner renders and Continue is enabled", () => {
		const { getByTestId } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		expect(getByTestId("provider-already-connected")).toBeInTheDocument();
		const cont = getByTestId("onboarding-step1-continue") as HTMLButtonElement;
		expect(cont.disabled).toBe(false);
	});

	test("data.hasProvider=false → 'already connected' banner absent, Continue disabled", () => {
		const { queryByTestId, getByTestId } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: false },
		});
		expect(queryByTestId("provider-already-connected")).toBeNull();
		const cont = getByTestId("onboarding-step1-continue") as HTMLButtonElement;
		expect(cont.disabled).toBe(true);
	});

	test("Step 1 Skip advances to Step 2 (tier picker visible)", async () => {
		const { getByTestId, getByText } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: false },
		});
		await fireEvent.click(getByTestId("onboarding-step1-skip"));
		expect(getByText("Pick a default tier")).toBeInTheDocument();
		// upsertSetting must NOT have been called from skipping step 1.
		expect(vi.mocked(upsertSetting)).not.toHaveBeenCalled();
	});

	test("Step 2 default selection is balanced; selecting Quality + Continue calls upsertSetting('provider:defaultTier','quality')", async () => {
		const { getByTestId, getByText, container } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		// Advance to Step 2.
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		expect(getByText("Pick a default tier")).toBeInTheDocument();

		const balanced = container.querySelector<HTMLInputElement>('input[value="balanced"]')!;
		expect(balanced.checked).toBe(true);

		const quality = container.querySelector<HTMLInputElement>('input[value="quality"]')!;
		await fireEvent.click(quality);
		expect(quality.checked).toBe(true);

		await fireEvent.click(getByTestId("onboarding-step2-continue"));
		await Promise.resolve();
		await Promise.resolve();

		expect(vi.mocked(upsertSetting)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledWith("provider:defaultTier", "quality");
		// Step 3 should now be visible.
		expect(getByText("Three keystrokes to know")).toBeInTheDocument();
	});

	test("prevents a second tier save while the first save is pending", async () => {
		let resolveSave: () => void = () => {};
		vi.mocked(upsertSetting).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		const { getByTestId, container } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		await fireEvent.click(container.querySelector<HTMLInputElement>('input[value="quality"]')!);
		const continueButton = getByTestId("onboarding-step2-continue") as HTMLButtonElement;
		await fireEvent.click(continueButton);
		expect(continueButton.disabled).toBe(true);
		expect(continueButton).toHaveTextContent("Saving...");
		await fireEvent.click(continueButton);
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledTimes(1);

		resolveSave();
		await waitFor(() => expect(container.textContent).toContain("Three keystrokes to know"));
	});

	test("a failed tier save keeps the selection at Step 2 and retries", async () => {
		vi.mocked(upsertSetting).mockRejectedValueOnce(new Error("offline"));
		const { getByTestId, getByText, container } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		const quality = container.querySelector<HTMLInputElement>('input[value="quality"]')!;
		await fireEvent.click(quality);
		await fireEvent.click(getByTestId("onboarding-step2-continue"));

		await waitFor(() => expect(getByTestId("onboarding-tier-save-error")).toHaveTextContent("Could not save"));
		expect(quality.checked).toBe(true);
		expect(container.querySelector('[data-testid="onboarding-step2-continue"]')).toBeInTheDocument();
		expect(container.textContent).not.toContain("Three keystrokes to know");

		await fireEvent.click(getByTestId("onboarding-step2-continue"));
		await waitFor(() => expect(getByText("Three keystrokes to know")).toBeInTheDocument());
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledTimes(2);
	});

	test("members see the admin-managed tier handoff", async () => {
		const { getByTestId, getByText, queryByText, queryByLabelText } = render(OnboardingPage, {
			data: { user: { ...baseUser, role: "member" as const }, hasProvider: false },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		expect(getByText("Admin-managed setup")).toBeInTheDocument();
		expect(getByTestId("member-tier-guidance")).toBeInTheDocument();
		expect(queryByText("Pick a default tier")).toBeNull();
		expect(queryByLabelText("Default model tier")).toBeNull();
	});

	test("Step 2 Skip does NOT call upsertSetting and still advances to Step 3", async () => {
		const { getByTestId, getByText } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		await fireEvent.click(getByTestId("onboarding-step2-skip"));
		expect(getByText("Three keystrokes to know")).toBeInTheDocument();
		expect(vi.mocked(upsertSetting)).not.toHaveBeenCalled();
	});

	test("Step 2 Continue WITHOUT user interaction does NOT call upsertSetting (no blind write)", async () => {
		const { getByTestId } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		// Default radio is pre-selected, but user hasn't clicked it.
		await fireEvent.click(getByTestId("onboarding-step2-continue"));
		await Promise.resolve();
		await Promise.resolve();
		expect(vi.mocked(upsertSetting)).not.toHaveBeenCalled();
	});

	test("Step 3 'Get started' POSTs /api/onboarding/complete and navigates to /", async () => {
		const { getByTestId } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		await fireEvent.click(getByTestId("onboarding-step2-continue"));
		await Promise.resolve();
		await fireEvent.click(getByTestId("onboarding-finish"));
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("/api/onboarding/complete");
		expect(init).toMatchObject({ method: "POST" });

		expect(window.location.href).toBe("/");
	});

	test("Step 3 'Get started' navigates to / even if /api/onboarding/complete fails", async () => {
		// Network failure on the completion call must not strand the user
		// on the wizard. The hook gate will catch them on the next page
		// load if the stamp didn't take.
		fetchSpy.mockRejectedValue(new Error("offline"));
		const { getByTestId } = render(OnboardingPage, {
			data: { user: baseUser, hasProvider: true },
		});
		await fireEvent.click(getByTestId("onboarding-step1-continue"));
		await fireEvent.click(getByTestId("onboarding-step2-continue"));
		await Promise.resolve();
		await fireEvent.click(getByTestId("onboarding-finish"));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(window.location.href).toBe("/");
	});
});
