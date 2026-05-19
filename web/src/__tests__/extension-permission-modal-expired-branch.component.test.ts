/**
 * Phase 4 (capability-expiry) — DOM tests for the PermissionGate's
 * expired-capability branch.
 *
 * Covers:
 *   - With `expiredCapability` set, the gate renders the re-approve copy
 *     (title + body verbatim per design doc § 3.2) and the three
 *     re-approve buttons (Approve $newTtl / Approve forever (admin only)
 *     / Cancel).
 *   - `isAdmin: false` hides the "Approve forever (admin only)" button;
 *     `isAdmin: true` reveals it.
 *   - "Approve $newTtl" click POSTs `{approved: true}` (no scope).
 *   - "Approve forever" click (admin) POSTs `{approved: true, scope:
 *     "forever"}`.
 *   - "Cancel" POSTs `{approved: false}` so the gate clears (dismissal
 *     is non-authoritative per design doc § 3.3 — sweep already revoked
 *     — but the modal still must close).
 *   - With `expiredCapability` undefined, the four-scope flow renders
 *     unchanged (regression sentinel — the prop addition must be purely
 *     additive).
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import PermissionGate from "$lib/components/tool-cards/PermissionGate.svelte";
import type { ToolCallState } from "$lib/stores.svelte.js";

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const DAY_MS = 24 * 60 * 60 * 1000;

function makeToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "prompt-ext-expired-1",
		toolName: "scratchpad__run_shell",
		status: "running",
		startedAt: Date.now(),
		permissionPending: true,
		extensionId: "scratchpad",
		capabilityKind: "shell",
		...overrides,
	};
}

describe("PermissionGate — expired-capability branch (Phase 4)", () => {
	test("renders Re-approve title + verbatim body when expiredCapability set", () => {
		const { getByTestId, queryByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 90 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: false,
			},
		});
		// Title verbatim per design doc § 3.2: "Re-approve $extensionName: $capability"
		const title = getByTestId("permission-expired-title");
		expect(title).toHaveTextContent(/Re-approve/);
		expect(title).toHaveTextContent(/scratchpad/);
		expect(title).toHaveTextContent(/shell/);

		// Body verbatim per design doc § 3.2: "Your permission for $cap
		// expired $age ago. Continue to grant for another $newTtl, or cancel."
		const body = getByTestId("permission-expired-body");
		expect(body).toHaveTextContent(/Your permission for shell/);
		expect(body).toHaveTextContent(/expired/);
		expect(body).toHaveTextContent(/90 days/); // age via humanizeDuration
		expect(body).toHaveTextContent(/Continue to grant for another/);
		expect(body).toHaveTextContent(/30 days/); // newTtl
		expect(body).toHaveTextContent(/or cancel/);

		// Buttons: default approve + cancel always; forever hidden for non-admin.
		expect(getByTestId("permission-expired-approve-default")).toHaveTextContent(/Approve 30 days/);
		expect(getByTestId("permission-expired-cancel")).toHaveTextContent(/Cancel/);
		expect(queryByTestId("permission-expired-approve-forever")).toBeNull();

		// Four-scope chooser MUST NOT render in expired branch.
		expect(queryByTestId("permission-scope-chooser")).toBeNull();
	});

	test("admin sees the 'Approve forever (admin only)' button", () => {
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: true,
			},
		});
		const foreverBtn = getByTestId("permission-expired-approve-forever");
		expect(foreverBtn).toBeInTheDocument();
		expect(foreverBtn).toHaveTextContent(/Approve forever \(admin only\)/);
	});

	test("'Approve $newTtl' POSTs {approved: true, ttlOverrideMs: <picker>} with no scope", async () => {
		// Phase 56: the chat-side approve path now carries the picker's
		// current `ttlOverrideMs` value (the picker defaults to the
		// `initialTtlMs` prop). Scope remains absent — Never on the
		// picker does NOT escalate scope (CONTEXT.md decision).
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: false,
			},
		});
		await fireEvent.click(getByTestId("permission-expired-approve-default"));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/tool-calls/prompt-ext-expired-1/permission",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approved: true, ttlOverrideMs: 30 * DAY_MS }),
			}),
		);
	});

	test("'Approve forever' POSTs {approved: true, scope: 'forever'} (admin only)", async () => {
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: true,
			},
		});
		await fireEvent.click(getByTestId("permission-expired-approve-forever"));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/tool-calls/prompt-ext-expired-1/permission",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approved: true, scope: "forever" }),
			}),
		);
	});

	test("'Cancel' POSTs {approved: false} so the gate clears", async () => {
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: false,
			},
		});
		await fireEvent.click(getByTestId("permission-expired-cancel"));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/tool-calls/prompt-ext-expired-1/permission",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approved: false }),
			}),
		);
	});

	test("Phase 56: renders the same data-testid='expired-reapprove-ttl-picker' with 7 options (parity with settings-side modal)", () => {
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: false,
			},
		});
		const picker = getByTestId("expired-reapprove-ttl-picker") as HTMLSelectElement;
		expect(picker.tagName).toBe("SELECT");
		const options = Array.from(picker.querySelectorAll("option"));
		expect(options.map((o) => o.textContent?.trim())).toEqual([
			"1h",
			"6h",
			"1d",
			"7d",
			"30d",
			"90d",
			"Never",
		]);
	});

	test("Phase 56: changing the picker live-updates the approve button label (parity assertion)", async () => {
		const HOUR_MS = 60 * 60 * 1000;
		const { getByTestId } = render(PermissionGate, {
			props: {
				toolCall: makeToolCall(),
				expiredCapability: {
					capability: "shell",
					ageMs: 91 * DAY_MS,
					initialTtlMs: 30 * DAY_MS,
				},
				isAdmin: false,
			},
		});
		// Default label reflects 30 days.
		expect(getByTestId("permission-expired-approve-default")).toHaveTextContent(
			"Approve 30 days",
		);
		const picker = getByTestId("expired-reapprove-ttl-picker") as HTMLSelectElement;
		await fireEvent.change(picker, { target: { value: String(HOUR_MS) } });
		expect(getByTestId("permission-expired-approve-default")).toHaveTextContent(
			"Approve 1 hour",
		);
	});

	test("REGRESSION: when expiredCapability is undefined, four-scope flow renders unchanged", () => {
		const { getByTestId, queryByTestId } = render(PermissionGate, {
			props: { toolCall: makeToolCall() }, // no expiredCapability, no isAdmin
		});
		// Existing four-scope flow MUST still render.
		expect(getByTestId("permission-scope-chooser")).toBeInTheDocument();
		expect(getByTestId("permission-allow-session")).toBeInTheDocument();
		expect(getByTestId("permission-allow-conversation")).toBeInTheDocument();
		expect(getByTestId("permission-allow-project")).toBeInTheDocument();
		expect(getByTestId("permission-allow-forever")).toBeInTheDocument();
		expect(getByTestId("permission-deny")).toBeInTheDocument();

		// Expired-branch testids MUST NOT render.
		expect(queryByTestId("permission-expired-title")).toBeNull();
		expect(queryByTestId("permission-expired-body")).toBeNull();
		expect(queryByTestId("permission-expired-actions")).toBeNull();
	});
});
