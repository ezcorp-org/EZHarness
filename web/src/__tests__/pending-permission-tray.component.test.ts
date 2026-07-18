/**
 * B3 — DOM tests for the fallback pending-permission tray.
 *
 * The tray renders permission prompts that have NO active run to host an
 * inline card — the extension-initiated case (ez-code-factory's init_gate
 * hitting fs.write / shell). Without it, the approval card never renders and
 * the backend gate hangs forever. Covers:
 *   - Empty store → nothing rendered.
 *   - A registered prompt → a PermissionGate card renders in the tray.
 *   - Approving (four-scope chooser) POSTs the decision AND removes the card
 *     from the tray (onResolved → dismissPendingPermission).
 *   - A prompt with no extensionId renders the legacy Allow/Deny gate and its
 *     header omits the extension suffix.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import PendingPermissionTray from "$lib/components/tool-cards/PendingPermissionTray.svelte";
import { store, registerPendingPermission, type ToolCallState } from "$lib/stores.svelte.js";

const fetchMock = vi.fn();

beforeEach(() => {
	store.pendingPermissions = [];
	fetchMock.mockReset();
	fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	store.pendingPermissions = [];
});

function makeExtPrompt(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "prompt-init-gate-1",
		toolName: "ez-code-factory__init_gate",
		status: "running",
		startedAt: Date.now(),
		permissionPending: true,
		extensionId: "ez-code-factory",
		capabilityKind: "shell",
		...overrides,
	};
}

describe("PendingPermissionTray", () => {
	test("renders nothing when there are no pending prompts", () => {
		const { queryByTestId } = render(PendingPermissionTray);
		expect(queryByTestId("pending-permission-tray")).toBeNull();
	});

	test("renders a PermissionGate card for a registered extension prompt", () => {
		registerPendingPermission(makeExtPrompt());
		const { getByTestId } = render(PendingPermissionTray);
		expect(getByTestId("pending-permission-tray")).toBeInTheDocument();
		// Extension-scoped prompt → four-scope chooser + extension badge.
		expect(getByTestId("permission-scope-chooser")).toBeInTheDocument();
		expect(getByTestId("permission-extension-badge")).toHaveTextContent("ez-code-factory");
	});

	test("approving POSTs the decision and removes the card from the tray", async () => {
		registerPendingPermission(makeExtPrompt());
		const { getByTestId, queryByTestId } = render(PendingPermissionTray);

		await fireEvent.click(getByTestId("permission-allow-session"));

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/tool-calls/prompt-init-gate-1/permission",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approved: true, scope: "session" }),
			}),
		);
		// onResolved → dismissPendingPermission drops the entry.
		expect(store.pendingPermissions).toHaveLength(0);
		expect(queryByTestId("pending-permission-tray")).toBeNull();
	});

	test("denying removes the card too", async () => {
		registerPendingPermission(makeExtPrompt());
		const { getByTestId } = render(PendingPermissionTray);

		await fireEvent.click(getByTestId("permission-deny"));

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/tool-calls/prompt-init-gate-1/permission",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approved: false }),
			}),
		);
		expect(store.pendingPermissions).toHaveLength(0);
	});

	test("a built-in prompt (no extensionId) renders the legacy gate with no extension suffix", () => {
		registerPendingPermission(
			makeExtPrompt({ id: "prompt-builtin-1", extensionId: undefined, capabilityKind: undefined, category: "execute" }),
		);
		const { getByTestId, queryByTestId } = render(PendingPermissionTray);
		expect(getByTestId("pending-permission-tray")).toBeInTheDocument();
		// Legacy two-button gate, no scope chooser.
		expect(getByTestId("permission-allow")).toBeInTheDocument();
		expect(queryByTestId("permission-scope-chooser")).toBeNull();
		expect(queryByTestId("permission-extension-badge")).toBeNull();
	});
});
