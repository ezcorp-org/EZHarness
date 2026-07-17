/**
 * Wiring test for ensureInitialized() → ExtensionStateMediator
 * (context.ts), Extension Pages Hub.
 *
 * The mediator's manifest-info lookup is the security seam that gates
 * `ezcorp/page-state` pushes: `pageIds` must come from the MANIFEST
 * (declaring a page IS the grant) while `eventSubscriptions` must come
 * from the runtime GRANT (`registry.getGrantedPermissions`) — NOT the
 * manifest request — so revoked events drop out of page-tree action
 * validation on the next reload. Nothing else asserted this pipeline:
 * a refactor that fed `manifest.permissions.eventSubscriptions` (the
 * REQUEST) into the mediator would ship a grant-bypass while every
 * mediator unit test stayed green.
 *
 * Strategy mirrors context-register-preview-bus.server.test.ts: stub
 * the whole boot graph inert, capture the ExtensionStateMediator
 * constructor args, then drive the captured lookup closure against a
 * stubbed registry and assert the grant-vs-manifest sourcing.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── The collaborator under observation ──────────────────────────────
const mediatorCtorArgs: unknown[][] = [];
const mediatorInstances: unknown[] = [];
// `setStateMediator` registers the process-wide mediator singleton so
// mediator-less executors (boot `bootExecutor`, per-request render-pull /
// events executors) still install the `ezcorp/page-state` handler. We
// capture the call to assert context.ts wires it to the SAME mediator it
// hands the in-process executor.
const setStateMediatorSingletonMock = vi.fn();
vi.mock("$server/extensions/state-mediator", () => ({
	ExtensionStateMediator: class {
		constructor(...args: unknown[]) {
			mediatorCtorArgs.push(args);
			mediatorInstances.push(this);
		}
	},
	setStateMediator: setStateMediatorSingletonMock,
}));

// ── Registry stub: manifest vs grant deliberately DISAGREE ──────────
// The manifest requests two events; the grant allows only one. The
// lookup must surface the GRANT.
const MANIFEST_WITH_PAGES = {
	name: "cron-dashboard",
	panel: { title: "Cron" },
	pages: [{ id: "dashboard", title: "Dash" }, { id: "stats", title: "Stats" }],
	permissions: { eventSubscriptions: ["cron-dashboard:clear-log", "cron-dashboard:revoked"] },
};
const MANIFEST_PLAIN = { name: "plain-ext", panel: undefined };

vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({
			loadFromDb: vi.fn(async () => undefined),
			getManifest: (extId: string) => {
				if (extId === "ext-pages") return MANIFEST_WITH_PAGES;
				if (extId === "ext-plain") return MANIFEST_PLAIN;
				return undefined;
			},
			getGrantedPermissions: (extId: string) =>
				extId === "ext-pages"
					? { eventSubscriptions: ["cron-dashboard:clear-log"] }
					: undefined,
			getAllManifests: () => new Map(),
			getProcessIfRunning: () => undefined,
			killAll: vi.fn(),
		}),
	},
}));

// ── Inert stubs for the rest of the boot graph ──────────────────────
vi.mock("$server/runtime/preview/preview-bus-registry", () => ({
	registerPreviewBus: vi.fn(),
	getRegisteredPreviewBus: () => null,
}));
vi.mock("$server/env-validation", () => ({ validateEnv: vi.fn() }));
vi.mock("$server/db/connection", () => ({
	initDb: vi.fn(async () => undefined),
	closeDb: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/shutdown", () => ({
	installShutdownHandlers: vi.fn(),
	registerTeardown: vi.fn(),
}));
vi.mock("$server/db/backup", () => ({
	startBackups: vi.fn(),
	stopBackups: vi.fn(),
}));
vi.mock("$server/extensions/bundled", () => ({
	ensureBundledExtensions: vi.fn(async () => undefined),
	bootSpawnFlaggedBundledExtensions: vi.fn(async () => undefined),
}));
vi.mock("$server/extensions/tool-executor", () => ({
	ToolExecutor: class {
		ensureSubprocessRpcWired = vi.fn();
	},
}));
vi.mock("$server/extensions/permission-engine", () => ({
	getPermissionEngine: vi.fn(() => ({})),
}));
vi.mock("$lib/server/security/bundled-creds", () => ({
	bootstrapBundledCredentials: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/security/openai-extension-creds", () => ({
	wireOpenAIExtensionCredentials: vi.fn(),
}));
vi.mock("$server/extensions/lifecycle-dispatcher", () => ({
	LifecycleHookDispatcher: class {
		registerExtension = vi.fn();
		start = vi.fn();
		stop = vi.fn();
	},
}));
vi.mock("$server/extensions/event-subscription-dispatcher", () => ({
	EventSubscriptionDispatcher: class {
		registerExtension = vi.fn();
		start = vi.fn();
		stop = vi.fn();
	},
}));
vi.mock("$server/db/queries/conversation-extensions", () => ({
	getConversationExtensionIds: vi.fn(async () => []),
}));
vi.mock("$server/runtime/commands/registry", () => ({
	createCommandRegistry: vi.fn(() => ({})),
}));
vi.mock("$server/db/queries/user-commands", () => ({
	listUserCommands: vi.fn(async () => []),
}));
vi.mock("$server/runtime/goal-host", () => ({
	initGoalHost: vi.fn(() => ({ start: vi.fn(async () => undefined), stop: vi.fn() })),
	parseGoalEnabled: vi.fn(() => false),
}));
vi.mock("$server/runtime/loader", () => ({
	loadAgents: vi.fn(async () => []),
}));
vi.mock("$server/runtime/workflow-loader", () => ({
	loadYamlWorkflows: vi.fn(async () => []),
}));
vi.mock("$server/db/queries/workflows", () => ({
	loadDbWorkflows: vi.fn(async () => []),
}));
vi.mock("$server/runtime/executor", () => ({
	AgentExecutor: class {
		setStateMediator = vi.fn();
		destroy = vi.fn();
	},
}));
vi.mock("$server/runtime/workflow-executor", () => ({
	WorkflowExecutor: class {},
}));

type MediatorLookup = (extId: string) =>
	| {
			name: string;
			panel?: unknown;
			pageIds?: string[];
			eventSubscriptions?: string[];
	  }
	| undefined;

describe("ensureInitialized — state-mediator lookup feeds pageIds from MANIFEST, allowedEvents from GRANTS", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mediatorCtorArgs.length = 0;
		mediatorInstances.length = 0;
		// ensureInitialized is once-only; reset modules so it re-runs.
		vi.resetModules();
	});

	test("the wired lookup sources pageIds from manifest.pages and eventSubscriptions from the runtime grant", async () => {
		const ctx = await import("$lib/server/context");
		await ctx.ensureInitialized();

		expect(mediatorCtorArgs).toHaveLength(1);
		const [bus, lookup] = mediatorCtorArgs[0]! as [unknown, MediatorLookup];
		expect(bus).toBe(ctx.getBus());

		// The SAME constructed mediator is registered as the process-wide
		// singleton (so boot/per-request mediator-less executors install
		// the page-state handler). This is the dashboard-live-refresh fix.
		expect(setStateMediatorSingletonMock).toHaveBeenCalledTimes(1);
		expect(setStateMediatorSingletonMock).toHaveBeenCalledWith(mediatorInstances[0]);

		// Pages extension: pageIds mirror the MANIFEST declaration;
		// eventSubscriptions mirror the GRANT — the manifest's extra
		// requested-but-revoked event must NOT leak through.
		const info = lookup("ext-pages");
		expect(info).toBeDefined();
		expect(info!.name).toBe("cron-dashboard");
		expect(info!.pageIds).toEqual(["dashboard", "stats"]);
		expect(info!.eventSubscriptions).toEqual(["cron-dashboard:clear-log"]);

		// No pages declared + no grant → neither key present (the
		// mediator's fail-closed defaults take over).
		const plain = lookup("ext-plain");
		expect(plain).toBeDefined();
		expect(plain!.name).toBe("plain-ext");
		expect(plain).not.toHaveProperty("pageIds");
		expect(plain).not.toHaveProperty("eventSubscriptions");

		// Unknown extension → undefined (mediator rejects the push).
		expect(lookup("ext-unknown")).toBeUndefined();
	});
});
