import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Logic tests for:
 * 1. `ext:state` WS event handler in stores.svelte.ts
 * 2. `extensionPanelStates` property access in stores.svelte.ts
 * 3. Pure derivation logic in ExtensionPanel.svelte
 *
 * Svelte 5 runes can't run under bun:test, so we mirror the handler and
 * derivation logic as plain functions and exercise them directly.
 */

// ── Minimal WSEvent shape ───────────────────────────────────────────────

interface WSEvent {
	type: string;
	data: unknown;
}

// ── Test double for ext:state handler (mirrors stores.svelte.ts) ────────

class ExtStateTestStore {
	extensionPanelStates: Record<string, { extensionName: string; state: Record<string, unknown> }> = {};

	/** Mirrors the `ext:state` case in the initStores WS subscriber */
	handleWSEvent(event: WSEvent): void {
		if (event.type !== "ext:state") return;
		const { extensionId, extensionName, state } = event.data as {
			extensionId: string; extensionName: string; state: Record<string, unknown>;
		};
		if (extensionId) {
			this.extensionPanelStates = {
				...this.extensionPanelStates,
				[extensionId]: { extensionName, state },
			};
		}
	}

}

// ── Types mirrored from ExtensionPanel.svelte ───────────────────────────

type BadgeColor = "blue" | "green" | "red" | "yellow" | "purple" | "gray";
type StatusState = "idle" | "running" | "success" | "error" | "warning";
type ListItemStatus = "pending" | "active" | "completed" | "failed";
type TextVariant = "muted" | "default" | "emphasis";

interface ExtensionPanelState {
	title: string;
	collapsed?: boolean;
	components: Array<{ type: string; [key: string]: unknown }>;
}

// ── Pure derivations extracted from ExtensionPanel.svelte ───────────────

function badgeColorClass(color?: BadgeColor): string {
	switch (color) {
		case "blue":   return "bg-blue-500/20 text-blue-300";
		case "green":  return "bg-green-500/20 text-green-300";
		case "red":    return "bg-red-500/20 text-red-300";
		case "yellow": return "bg-yellow-500/20 text-yellow-300";
		case "purple": return "bg-purple-500/20 text-purple-300";
		default:       return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
	}
}

function statusDotClass(s: StatusState): string {
	switch (s) {
		case "running": return "bg-blue-400 animate-pulse";
		case "success": return "bg-green-500";
		case "error":   return "bg-red-500";
		case "warning": return "bg-yellow-500";
		default:        return "bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]";
	}
}

function listStatusIcon(s?: ListItemStatus): string {
	switch (s) {
		case "active":    return "\u25B6";
		case "completed": return "\u2713";
		case "failed":    return "\u2717";
		default:          return "\u25CB";
	}
}

function listStatusColor(s?: ListItemStatus): string {
	switch (s) {
		case "active":    return "text-blue-400";
		case "completed": return "text-green-400";
		case "failed":    return "text-red-400";
		default:          return "text-[var(--color-text-muted)]";
	}
}

function textVariantClass(v?: TextVariant): string {
	switch (v) {
		case "muted":    return "text-[var(--color-text-muted)]";
		case "emphasis": return "text-[var(--color-text-primary)] font-medium";
		default:         return "text-[var(--color-text-secondary)]";
	}
}

/** Mirrors the $derived panelState validation in ExtensionPanel.svelte (lines 45-50) */
function validatePanelState(state: Record<string, unknown>): ExtensionPanelState | null {
	if (!state || typeof state !== "object") return null;
	if (typeof state.title !== "string") return null;
	if (!Array.isArray(state.components)) return null;
	return state as unknown as ExtensionPanelState;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// ── ext:state WS handler ────────────────────────────────────────────────

describe("ext:state WS event handler", () => {
	let store: ExtStateTestStore;

	beforeEach(() => {
		store = new ExtStateTestStore();
	});

	test("stores extension state under extensionId", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: {
				extensionId: "ext-1",
				extensionName: "task-stack",
				state: { title: "My Panel", components: [] },
			},
		});
		expect(store.extensionPanelStates["ext-1"]).toEqual({
			extensionName: "task-stack",
			state: { title: "My Panel", components: [] },
		});
	});

	test("multiple extensions stored independently", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-a", extensionName: "alpha", state: { title: "A", components: [] } },
		});
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-b", extensionName: "beta", state: { title: "B", components: [] } },
		});
		expect(Object.keys(store.extensionPanelStates).sort()).toEqual(["ext-a", "ext-b"]);
		expect(store.extensionPanelStates["ext-a"]!.extensionName).toBe("alpha");
		expect(store.extensionPanelStates["ext-b"]!.extensionName).toBe("beta");
	});

	test("upserts same extensionId with new state", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "V1", components: [] } },
		});
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "V2", components: [{ type: "badge" }] } },
		});
		expect(store.extensionPanelStates["ext-1"]!.state.title).toBe("V2");
		expect((store.extensionPanelStates["ext-1"]!.state.components as unknown[]).length).toBe(1);
	});

	test("updating one extension does not affect another", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-a", extensionName: "alpha", state: { title: "A", components: [] } },
		});
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-b", extensionName: "beta", state: { title: "B", components: [] } },
		});
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-a", extensionName: "alpha", state: { title: "A2", components: [] } },
		});
		expect(store.extensionPanelStates["ext-a"]!.state.title).toBe("A2");
		expect(store.extensionPanelStates["ext-b"]!.state.title).toBe("B");
	});

	test("creates new object reference on each update (immutable)", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "V1", components: [] } },
		});
		const before = store.extensionPanelStates;
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-2", extensionName: "other", state: { title: "V1", components: [] } },
		});
		expect(store.extensionPanelStates).not.toBe(before);
	});

	test("missing extensionId is a no-op (guard check)", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "", extensionName: "bad", state: {} },
		});
		expect(store.extensionPanelStates).toEqual({});
	});

	test("undefined extensionId is a no-op", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionName: "bad", state: {} },
		});
		expect(store.extensionPanelStates).toEqual({});
	});

	test("non ext:state events are ignored", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "test", state: { title: "X", components: [] } },
		});
		store.handleWSEvent({ type: "run:start", data: {} });
		store.handleWSEvent({ type: "task:snapshot", data: {} });
		expect(Object.keys(store.extensionPanelStates)).toEqual(["ext-1"]);
	});
});

// ── extensionPanelStates direct access ─────────────────────────────────

describe("extensionPanelStates direct access", () => {
	let store: ExtStateTestStore;

	beforeEach(() => {
		store = new ExtStateTestStore();
	});

	test("returns undefined for unknown extensionId", () => {
		expect(store.extensionPanelStates["missing"]).toBeUndefined();
	});

	test("returns the state for a known extensionId", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "Panel", components: [] } },
		});
		const result = store.extensionPanelStates["ext-1"];
		expect(result).toBeDefined();
		expect(result!.extensionName).toBe("task-stack");
		expect(result!.state.title).toBe("Panel");
	});

	test("returns undefined when queried for a different extension", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "Panel", components: [] } },
		});
		expect(store.extensionPanelStates["ext-2"]).toBeUndefined();
	});

	test("reflects the latest state after multiple updates", () => {
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "V1", components: [] } },
		});
		store.handleWSEvent({
			type: "ext:state",
			data: { extensionId: "ext-1", extensionName: "task-stack", state: { title: "V2", components: [{ type: "badge" }] } },
		});
		expect(store.extensionPanelStates["ext-1"]!.state.title).toBe("V2");
	});
});

// ── panelState validation ───────────────────────────────────────────────

describe("panelState validation (ExtensionPanel.svelte)", () => {
	test("valid state passes", () => {
		const result = validatePanelState({ title: "Test", components: [] });
		expect(result).not.toBeNull();
		expect(result!.title).toBe("Test");
	});

	test("null state returns null", () => {
		expect(validatePanelState(null as any)).toBeNull();
	});

	test("missing title returns null", () => {
		expect(validatePanelState({ components: [] })).toBeNull();
	});

	test("non-string title returns null", () => {
		expect(validatePanelState({ title: 42, components: [] })).toBeNull();
	});

	test("missing components returns null", () => {
		expect(validatePanelState({ title: "Test" })).toBeNull();
	});

	test("non-array components returns null", () => {
		expect(validatePanelState({ title: "Test", components: "bad" })).toBeNull();
	});

	test("valid state with components passes", () => {
		const result = validatePanelState({
			title: "Deploy",
			components: [
				{ type: "header", title: "Status" },
				{ type: "progress", value: 75, label: "Progress" },
			],
		});
		expect(result).not.toBeNull();
		expect(result!.components.length).toBe(2);
	});

	test("collapsed field is preserved", () => {
		const result = validatePanelState({ title: "Test", collapsed: true, components: [] });
		expect(result!.collapsed).toBe(true);
	});
});

// ── badgeColorClass ─────────────────────────────────────────────────────

describe("badgeColorClass", () => {
	test("blue", () => {
		expect(badgeColorClass("blue")).toBe("bg-blue-500/20 text-blue-300");
	});

	test("green", () => {
		expect(badgeColorClass("green")).toBe("bg-green-500/20 text-green-300");
	});

	test("red", () => {
		expect(badgeColorClass("red")).toBe("bg-red-500/20 text-red-300");
	});

	test("yellow", () => {
		expect(badgeColorClass("yellow")).toBe("bg-yellow-500/20 text-yellow-300");
	});

	test("purple", () => {
		expect(badgeColorClass("purple")).toBe("bg-purple-500/20 text-purple-300");
	});

	test("gray falls to default", () => {
		expect(badgeColorClass("gray")).toContain("bg-[var(--color-surface-tertiary)]");
	});

	test("undefined falls to default", () => {
		expect(badgeColorClass(undefined)).toContain("bg-[var(--color-surface-tertiary)]");
	});
});

// ── statusDotClass ──────────────────────────────────────────────────────

describe("statusDotClass", () => {
	test("running → blue pulse", () => {
		expect(statusDotClass("running")).toBe("bg-blue-400 animate-pulse");
	});

	test("success → green", () => {
		expect(statusDotClass("success")).toBe("bg-green-500");
	});

	test("error → red", () => {
		expect(statusDotClass("error")).toBe("bg-red-500");
	});

	test("warning → yellow", () => {
		expect(statusDotClass("warning")).toBe("bg-yellow-500");
	});

	test("idle → muted with border", () => {
		expect(statusDotClass("idle")).toContain("border");
	});
});

// ── listStatusIcon ──────────────────────────────────────────────────────

describe("listStatusIcon", () => {
	test("active → play triangle", () => {
		expect(listStatusIcon("active")).toBe("\u25B6");
	});

	test("completed → checkmark", () => {
		expect(listStatusIcon("completed")).toBe("\u2713");
	});

	test("failed → X", () => {
		expect(listStatusIcon("failed")).toBe("\u2717");
	});

	test("pending → circle", () => {
		expect(listStatusIcon("pending")).toBe("\u25CB");
	});

	test("undefined → circle (default)", () => {
		expect(listStatusIcon(undefined)).toBe("\u25CB");
	});
});

// ── listStatusColor ─────────────────────────────────────────────────────

describe("listStatusColor", () => {
	test("active → blue", () => {
		expect(listStatusColor("active")).toContain("blue");
	});

	test("completed → green", () => {
		expect(listStatusColor("completed")).toContain("green");
	});

	test("failed → red", () => {
		expect(listStatusColor("failed")).toContain("red");
	});

	test("pending → muted", () => {
		expect(listStatusColor("pending")).toContain("text-muted");
	});

	test("undefined → muted", () => {
		expect(listStatusColor(undefined)).toContain("text-muted");
	});
});

// ── textVariantClass ────────────────────────────────────────────────────

describe("textVariantClass", () => {
	test("muted → muted text", () => {
		expect(textVariantClass("muted")).toContain("text-muted");
	});

	test("emphasis → primary + font-medium", () => {
		const result = textVariantClass("emphasis");
		expect(result).toContain("text-primary");
		expect(result).toContain("font-medium");
	});

	test("default → secondary text", () => {
		expect(textVariantClass("default")).toContain("text-secondary");
	});

	test("undefined → secondary text (default)", () => {
		expect(textVariantClass(undefined)).toContain("text-secondary");
	});
});
