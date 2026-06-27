<script lang="ts">
	import { page } from "$app/stores";
	import { onMount } from "svelte";
	import { store } from "$lib/stores.svelte.js";
	import type { SettingsSchema } from "$server/extensions/types";
	import SettingsPanel from "./SettingsPanel.svelte";
	import CapabilitiesPanel from "$lib/components/extensions/CapabilitiesPanel.svelte";
	import UsesList from "$lib/components/extensions/UsesList.svelte";
	import type { HeldCapabilityView, SearchGrant } from "$lib/capability-policy-ui.js";
	import JsonBlock from "$lib/components/JsonBlock.svelte";
	import { invalidateExtensionSettings } from "$lib/stores/extensionSettings";
	import ExpiredGrantsBanner, {
		type ExpiredGrant,
	} from "$lib/components/permissions/ExpiredGrantsBanner.svelte";
	import ExpiredReapproveModal from "$lib/components/permissions/ExpiredReapproveModal.svelte";
	import { DEFAULT_TTL_FIRST_USE_MS } from "$lib/components/permissions/expiry-copy";
	import EntityTable from "$lib/components/EntityTable.svelte";
	import { updateMcpServer, type McpServerSpec } from "$lib/api";

	// Phase 56: per-capability TTL UI. The picker default seed comes
	// from the batch-loaded expired-grants response: each row carries
	// `stickyTtlMs` (the user's last picker selection for that
	// capability kind) or `null` (first use). Plan 56-03 read-on-mount
	// path — see `web/src/routes/api/extensions/[id]/expired-grants/
	// +server.ts` for the enrichment. The page passes
	// `row.stickyTtlMs ?? DEFAULT_TTL_FIRST_USE_MS` to the modal's
	// `initialTtlMs` prop so the dropdown opens at the sticky default.

	interface ExtensionDetail {
		id: string;
		name: string;
		version: string;
		description: string;
		enabled: boolean;
		source: string;
		installPath: string;
		checksumVerified: boolean;
		consecutiveFailures: number;
		// Creator-modify gate. `creatorUserId` is set only for
		// user-authored installs; `modifiable` is the admin-only flag
		// that authorizes the creator to re-open/edit it.
		creatorUserId?: string | null;
		modifiable?: boolean;
		isBundled?: boolean;
		manifest: {
			// Manifest schema defines author as an object; old installs may
			// still carry a bare string.
			author?: string | { name: string; id?: string };
			entrypoint: string;
			persistent?: boolean;
			// MCP-kind extensions carry a connection config (mcpServers[0]) and
			// `kind:"mcp"`. The Connection panel below renders for these.
			kind?: "local" | "mcp";
			mcpServers?: Array<
				| { transport: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string> }
				| { transport: "http"; name: string; url: string; headers?: Record<string, string> }
				| { transport: "sse"; name: string; url: string; headers?: Record<string, string> }
			>;
			tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
			// Phase 4 — ext-to-ext composition. Read-only "Uses" chips below.
			dependencies?: Record<string, { source?: string; version?: string }>;
			// Extension Pages Hub — declared Hub tabs. Declaring a page IS
			// the grant (no permission key), so this list is the user-facing
			// surface of what the extension adds to /hub.
			pages?: Array<{ id: string; title: string; icon?: string; description?: string }>;
			permissions: {
				network?: string[];
				filesystem?: string[];
				shell?: boolean;
				env?: string[];
			};
			settings?: SettingsSchema;
			// Phase 5 (defineEntity SDK) — entity declarations drive the
			// auto-generated per-type table sections below. We only need
			// the public surface used by EntityTable.svelte's prop type,
			// not the SDK's full EntityDeclaration shape.
			entities?: Array<{
				type: string;
				label: string;
				pluralLabel: string;
				scope?: "user" | "project" | "conversation";
				schema: Record<string, unknown> & {
					type: "object";
					properties?: Record<string, unknown>;
					required?: readonly string[];
				};
				preview?: string;
			}>;
			// Phase 4 deputy / orchestration manifest opt-ins. Both
			// surface as separate consent checkboxes when the manifest
			// declares them.
			acceptsCallerCaps?: boolean;
			escalateChildCaps?: boolean;
		};
		grantedPermissions: {
			network?: string[];
			filesystem?: string[];
			shell?: boolean;
			env?: string[];
			acceptsCallerCaps?: boolean;
			escalateChildCaps?: boolean;
			grantedAt: Record<string, number>;
		};
		createdAt: string;
	}

	let ext = $state<ExtensionDetail | null>(null);
	let loading = $state(true);
	let errorMsg = $state("");
	let successMsg = $state("");
	let saving = $state(false);

	// Editable permissions (cloned from ext.grantedPermissions)
	let editPerms = $state<{
		network: string[];
		filesystem: string[];
		shell: boolean;
		env: string[];
		acceptsCallerCaps: boolean;
		escalateChildCaps: boolean;
	}>({
		network: [],
		filesystem: [],
		shell: false,
		env: [],
		acceptsCallerCaps: false,
		escalateChildCaps: false,
	});

	// Always-allow state for sensitive ops
	let alwaysAllowShell = $state(false);
	let alwaysAllowFs = $state(false);

	// Security violations
	interface Violation {
		reason: string;
		path: string;
		timestamp: string;
	}
	let violations = $state<Violation[]>([]);
	let isAdmin = $state(false);
	let currentUserId = $state<string | null>(null);
	let clearingViolations = $state(false);
	let modifyBusy = $state(false);
	let modifiableBusy = $state(false);

	const extId = $derived($page.params.id);
	const hasViolations = $derived(violations.length > 0);

	// github-projects is the ONE extension whose primary configuration is
	// per-project (connecting a board), not the single global settings panel
	// above. We surface a discoverable link to that per-project connect
	// surface here. Gate on the extension name — the top-level `ext.name`
	// (mirrors `manifest.name`) is the stable identity.
	const isGithubProjects = $derived(ext?.name === "github-projects");
	// Where the per-project connect surface lives. This route's `[id]` is the
	// EXTENSION id, and the (app) layout syncs `store.activeProjectId` to the
	// URL's `[id]` param — so on this page `activeProjectId` is polluted with
	// the extension id. We therefore resolve the target project from the real
	// project list: use `activeProjectId` only if it names an actual project,
	// else the first non-global project. Falls back to project selection ("/")
	// when there is none, so the link never dead-ends.
	const targetProjectId = $derived.by((): string | null => {
		const active = store.activeProjectId;
		if (active && active !== "global" && store.projects.some((p) => p.id === active)) {
			return active;
		}
		const firstReal = store.projects.find((p) => p.id !== "global");
		return firstReal?.id ?? null;
	});
	const ghProjectsConnectHref = $derived(
		targetProjectId ? `/project/${targetProjectId}/integrations/github-projects` : "/",
	);

	// Hub Pages cards deep-link into the PROJECT-scoped hub route
	// (`/project/<id>/hub/...`), not the global "home" hub, so the user
	// stays in their project context and Back returns here. Reuse the
	// `targetProjectId` resolution above, falling back to the always-valid
	// synthetic "global" project so the link is always a project hub route
	// and never dead-ends.
	const hubProjectId = $derived(targetProjectId ?? "global");

	let settingsSchema = $state<SettingsSchema>({});
	let userValues = $state<Record<string, unknown>>({});
	let capabilities = $state<HeldCapabilityView[]>([]);
	let settingsLoaded = $state(false);
	let settingsError = $state("");

	const hasSchema = $derived(Object.keys(settingsSchema).length > 0);

	function authorName(author?: string | { name: string; id?: string }): string {
		return typeof author === "string" ? author : (author?.name ?? "");
	}

	async function loadSettings() {
		try {
			const res = await fetch(`/api/extensions/${extId}/settings`);
			if (!res.ok) {
				if (res.status === 409) {
					settingsSchema = {};
					settingsLoaded = true;
				} else {
					settingsError = `Failed to load settings (HTTP ${res.status})`;
					settingsLoaded = true;
				}
				return;
			}
			const data = await res.json();
			settingsSchema = (data.schema ?? {}) as SettingsSchema;
			userValues = (data.userValues ?? {}) as Record<string, unknown>;
			capabilities = (data.capabilities ?? []) as HeldCapabilityView[];
			settingsLoaded = true;
		} catch (e) {
			settingsError = e instanceof Error ? e.message : "Failed to load settings";
			settingsLoaded = true;
		}
	}

	async function saveUserSettings(next: Record<string, unknown>) {
		const res = await fetch(`/api/extensions/${extId}/settings/user`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ values: next }),
		});
		if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`);
		if (ext) invalidateExtensionSettings(ext.name);
		showTemporarySuccess("Settings saved");
		await loadSettings();
	}

	async function resetUserSettings() {
		const res = await fetch(`/api/extensions/${extId}/settings/user`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Reset failed: HTTP ${res.status}`);
		if (ext) invalidateExtensionSettings(ext.name);
		showTemporarySuccess("Settings reset to default");
		await loadSettings();
	}

	// §5.2 — persist a host-capability grant override (the security
	// CEILING). Writes the GRANT via the EXISTING admin permissions PUT
	// (clamped to manifest server-side), NOT the per-user settings route.
	// Merge into the current grant so unrelated permissions are preserved.
	async function saveCapabilityGrant(cap: string, grant: SearchGrant) {
		const res = await fetch(`/api/extensions/${extId}/permissions`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				permissions: { ...(ext?.grantedPermissions ?? {}), [cap]: grant },
			}),
		});
		if (!res.ok) throw new Error(`Capability save failed: HTTP ${res.status}`);
		showTemporarySuccess("Capability policy saved");
		await loadSettings();
	}

	async function checkAdmin() {
		try {
			const res = await fetch("/api/auth/me");
			if (res.ok) {
				const data = await res.json();
				currentUserId = data.user?.id ?? null;
				if (data.user?.role === "admin") isAdmin = true;
			}
		} catch {
			// not admin
		}
	}

	// Owner action: re-open this extension as an editable draft, then
	// jump to the existing editable preview. Server is the authority
	// (creator + modifiable + not-bundled); this gate is UX only.
	async function reopenForEdit() {
		if (!ext || modifyBusy) return;
		modifyBusy = true;
		errorMsg = "";
		try {
			const res = await fetch(`/api/extensions/${extId}/reopen`, {
				method: "POST",
			});
			if (!res.ok) {
				errorMsg =
					res.status === 404
						? "This extension can no longer be modified (an admin may have turned it off)."
						: "Failed to re-open this extension for editing.";
				return;
			}
			const { draftId } = await res.json();
			window.location.href = `/extensions/author?prefill=${encodeURIComponent(draftId)}`;
		} catch {
			errorMsg = "Failed to re-open this extension for editing.";
		} finally {
			modifyBusy = false;
		}
	}

	// Admin-only: flip the `modifiable` gate. Server enforces the admin
	// role + audits; this is the affordance.
	async function toggleModifiable() {
		if (!ext || modifiableBusy) return;
		modifiableBusy = true;
		errorMsg = "";
		try {
			const res = await fetch(`/api/extensions/${extId}/modifiable`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modifiable: !ext.modifiable }),
			});
			if (!res.ok) {
				errorMsg = "Failed to update the modifiable setting.";
				return;
			}
			await loadExtension();
		} catch {
			errorMsg = "Failed to update the modifiable setting.";
		} finally {
			modifiableBusy = false;
		}
	}

	async function loadViolations() {
		if (!isAdmin) return;
		try {
			const res = await fetch(`/api/extensions/${extId}/violations`);
			if (res.ok) {
				violations = await res.json();
			}
		} catch {
			// ignore — violations endpoint may not exist yet
		}
	}

	async function clearViolations() {
		clearingViolations = true;
		try {
			const res = await fetch(`/api/extensions/${extId}/violations`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to clear violations");
			showTemporarySuccess("Violations cleared");
			await loadViolations();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to clear violations";
		} finally {
			clearingViolations = false;
		}
	}

	function relativeTime(timestamp: string): string {
		const now = Date.now();
		const then = new Date(timestamp).getTime();
		const diffMs = now - then;
		const diffSec = Math.floor(diffMs / 1000);
		if (diffSec < 60) return "just now";
		const diffMin = Math.floor(diffSec / 60);
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr}h ago`;
		const diffDays = Math.floor(diffHr / 24);
		return `${diffDays}d ago`;
	}

	async function loadExtension() {
		try {
			const res = await fetch(`/api/extensions/${extId}`);
			if (!res.ok) throw new Error("Extension not found");
			ext = await res.json();
			if (ext) {
				editPerms = {
					network: ext.grantedPermissions.network ?? [],
					filesystem: ext.grantedPermissions.filesystem ?? [],
					shell: ext.grantedPermissions.shell ?? false,
					env: ext.grantedPermissions.env ?? [],
					acceptsCallerCaps: ext.grantedPermissions.acceptsCallerCaps === true,
					escalateChildCaps: ext.grantedPermissions.escalateChildCaps === true,
				};
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to load extension";
		} finally {
			loading = false;
		}
	}

	// Phase 4 (capability-expiry) — expired-grants banner state. Loaded
	// for any authenticated user (the audit rows for a single extension
	// are not admin-gated; the more detailed audit drill-down at
	// /audit IS).
	let expiredGrants = $state<ExpiredGrant[]>([]);
	let expiredGrantsError = $state("");

	// Inline re-approve modal state. The settings page does NOT have an
	// active tool call to gate (those are chat-side); the in-chat
	// PermissionGate handles those. The banner here pops a small
	// `ExpiredReapproveModal` that shares the design doc § 3.2 copy
	// contract with PermissionGate's expired branch but POSTs to
	// /api/extensions/[id]/reapprove (the install-time-equivalent
	// re-grant path) instead of /api/tool-calls/:id/permission.
	type ReapproveTarget = {
		capability: string;
		ageMs: number;
		stickyTtlMs?: number | null;
	};
	let reapproveModal = $state<ReapproveTarget | null>(null);
	let reapproveSubmitting = $state(false);

	async function loadExpiredGrants() {
		try {
			const res = await fetch(`/api/extensions/${extId}/expired-grants`);
			if (!res.ok) {
				expiredGrantsError = `Failed to load expired grants (HTTP ${res.status})`;
				return;
			}
			const data = await res.json();
			expiredGrants = (data.grants ?? []) as ExpiredGrant[];
		} catch (e) {
			expiredGrantsError = e instanceof Error ? e.message : "Failed to load expired grants";
		}
	}

	function handleReapproveOpen(target: ReapproveTarget) {
		reapproveModal = target;
	}

	async function handleReapproveSubmit(
		scope?: "forever",
		ttlOverrideMs?: number | null,
	) {
		if (!reapproveModal || !ext) return;
		reapproveSubmitting = true;
		try {
			// Phase 56: thread the picker's per-row TTL selection through
			// the POST body. `scope === "forever"` is the admin-gated
			// escalation path (defense-in-depth on the server). Picker
			// Never (`ttlOverrideMs: null`) on a non-forever scope is
			// allowed for any authenticated user — server-side validator
			// accepts `number > 0 | null | omitted`.
			const body: Record<string, unknown> = {
				capability: reapproveModal.capability,
			};
			if (scope) body.scope = scope;
			if (ttlOverrideMs !== undefined) body.ttlOverrideMs = ttlOverrideMs;
			const res = await fetch(`/api/extensions/${ext.id}/reapprove`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(`Re-approve failed (HTTP ${res.status})`);
			showTemporarySuccess("Permission re-approved");
			reapproveModal = null;
			await Promise.all([loadExpiredGrants(), loadExtension()]);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Re-approve failed";
		} finally {
			reapproveSubmitting = false;
		}
	}

	function handleReapproveCancel() {
		reapproveModal = null;
	}

	// Permission-change audit trail (admin-only). Rows sourced from the
	// shared `audit_log` table via `/api/extensions/[id]/audit`; covers
	// both typed `ext:*` events and legacy `extension:*` strings.
	interface AuditEntry {
		id: string;
		userId: string | null;
		action: string;
		target: string | null;
		metadata: Record<string, unknown> | null;
		createdAt: string;
	}
	let auditEntries = $state<AuditEntry[]>([]);
	let auditLoading = $state(false);
	let auditError = $state("");

	async function loadAuditTrail() {
		if (!isAdmin) return;
		auditLoading = true;
		try {
			const res = await fetch(`/api/extensions/${extId}/audit`);
			if (!res.ok) throw new Error(`Audit fetch failed: ${res.status}`);
			const data = await res.json();
			auditEntries = data.entries as AuditEntry[];
		} catch (e) {
			auditError = e instanceof Error ? e.message : "Failed to load audit trail";
		} finally {
			auditLoading = false;
		}
	}

	function shortActor(userId: string | null, metadata: Record<string, unknown> | null): string {
		const actor = metadata?.actor;
		if (actor === "system") return "system";
		if (typeof actor === "string" && actor) return `admin:${actor.slice(0, 8)}`;
		if (userId) return `admin:${userId.slice(0, 8)}`;
		return "unknown";
	}

	function auditSummary(e: AuditEntry): string {
		const m = e.metadata ?? {};
		const perm = (m.permission as string | undefined) ?? "";
		const reason = (m.reason as string | undefined) ?? "";
		// Typed events surface permission + reason; legacy events fall
		// back to the raw action + whatever metadata shape they used.
		if (e.action.startsWith("ext:")) {
			const verb = e.action.slice(4).replace(/-/g, " ");
			return perm ? `${verb} (${perm})${reason ? " — " + reason : ""}` : verb;
		}
		return e.action.replace(/:/g, " ");
	}

	onMount(async () => {
		await checkAdmin();
		await Promise.all([
			loadExtension(),
			loadViolations(),
			loadAuditTrail(),
			loadSettings(),
			loadExpiredGrants(),
		]);
	});

	function showTemporarySuccess(msg: string) {
		successMsg = msg;
		setTimeout(() => (successMsg = ""), 3000);
	}

	async function savePermissions() {
		if (!ext) return;
		saving = true;
		errorMsg = "";
		try {
			const res = await fetch(`/api/extensions/${ext.id}/permissions`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					permissions: {
						...editPerms,
						grantedAt: ext.grantedPermissions.grantedAt ?? {},
					},
				}),
			});
			if (!res.ok) throw new Error("Failed to save permissions");
			showTemporarySuccess("Permissions saved");
			await loadExtension();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Save failed";
		} finally {
			saving = false;
		}
	}

	async function toggleAlwaysAllow(opType: "shell" | "filesystem", current: boolean) {
		if (!ext) return;
		const action = current ? "deny" : "always_allow";
		try {
			await fetch(`/api/extensions/${ext.id}/confirm`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ operationType: opType, action }),
			});
			if (opType === "shell") alwaysAllowShell = !current;
			else alwaysAllowFs = !current;
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to update";
		}
	}

	// ── MCP Connection edit (Phase 3/B) ─────────────────────────────────
	const isMcp = $derived(ext?.manifest.kind === "mcp");
	const mcpServer = $derived(ext?.manifest.mcpServers?.[0] ?? null);

	let mcpEditOpen = $state(false);
	let mcpSaving = $state(false);
	let mcpToolDelta = $state<{ added: string[]; removed: string[] } | null>(null);
	// Edit form fields (pre-filled from the current server config on open).
	let mcpTransport = $state<"stdio" | "http" | "sse">("stdio");
	let mcpName = $state("");
	let mcpDescription = $state("");
	let mcpCommand = $state("");
	let mcpArgs = $state("");
	let mcpUrl = $state("");
	// Header KEYS only are pre-filled; values are left blank (blank = keep
	// the existing secret). Secrets are never sent to the client.
	let mcpHeaders = $state("");

	function openMcpEdit() {
		const s = mcpServer;
		if (!s) return;
		mcpToolDelta = null;
		mcpTransport = s.transport;
		mcpName = s.name;
		mcpDescription = ext?.description ?? "";
		if (s.transport === "stdio") {
			mcpCommand = s.command;
			mcpArgs = (s.args ?? []).join(" ");
			mcpUrl = "";
			mcpHeaders = "";
		} else {
			mcpCommand = "";
			mcpArgs = "";
			mcpUrl = s.url;
			// Pre-fill header keys with blank values so the user sees which
			// headers exist without exposing the secret. Blank value on save =
			// keep existing.
			mcpHeaders = Object.keys(s.headers ?? {})
				.map((k) => `${k}: `)
				.join("\n");
		}
		mcpEditOpen = true;
	}

	function parseHeaders(raw: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const line of raw.split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx === -1) continue;
			const k = line.slice(0, idx).trim();
			const v = line.slice(idx + 1).trim();
			if (k) out[k] = v;
		}
		return out;
	}

	async function saveMcpEdit() {
		if (!ext) return;
		mcpSaving = true;
		errorMsg = "";
		mcpToolDelta = null;
		try {
			let server: McpServerSpec;
			if (mcpTransport === "stdio") {
				if (!mcpCommand.trim()) {
					errorMsg = "Command is required for stdio transport";
					return;
				}
				const args = mcpArgs.trim() ? mcpArgs.trim().split(/\s+/) : [];
				server = { transport: "stdio", name: mcpName.trim(), command: mcpCommand.trim(), args };
			} else {
				if (!mcpUrl.trim()) {
					errorMsg = "URL is required for http/sse transport";
					return;
				}
				server = { transport: mcpTransport, name: mcpName.trim(), url: mcpUrl.trim(), headers: parseHeaders(mcpHeaders) };
			}

			const before = new Set((ext.manifest.tools ?? []).map((t) => t.name));
			const updated = (await updateMcpServer(ext.id, {
				description: mcpDescription.trim(),
				server,
			})) as { manifest?: { tools?: Array<{ name: string }> } };
			const afterTools = updated?.manifest?.tools ?? [];
			const after = new Set(afterTools.map((t) => t.name));
			mcpToolDelta = {
				added: [...after].filter((n) => !before.has(n)),
				removed: [...before].filter((n) => !after.has(n)),
			};
			mcpEditOpen = false;
			showTemporarySuccess("Connection updated");
			await loadExtension();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to update connection";
		} finally {
			mcpSaving = false;
		}
	}
</script>

<div class="space-y-6">
	<a href="/extensions" class="text-sm text-blue-400 hover:text-blue-300">&larr; Back to Extensions</a>

	{#if loading}
		<p class="text-[var(--color-text-muted)]">Loading...</p>
	{:else if !ext}
		<p class="text-red-400">Extension not found</p>
	{:else}
		<!-- Header -->
		<div class="flex items-start justify-between">
			<div>
				<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">{ext.name}</h2>
				<p class="text-sm text-[var(--color-text-secondary)]">v{ext.version}{authorName(ext.manifest.author) ? ` by ${authorName(ext.manifest.author)}` : ""}</p>
				<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{ext.description}</p>
			</div>
			<div class="flex items-center gap-3">
				<a
					href={`/extensions/${ext.id}/audit`}
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
					data-testid="extension-detail-audit-link"
				>
					Audit
				</a>
				{#if ext.checksumVerified}
					<span class="rounded-full bg-green-900/40 px-2 py-0.5 text-xs text-green-400">Verified</span>
				{:else}
					<span class="rounded-full bg-amber-900/40 px-2 py-0.5 text-xs text-amber-400">Unsigned</span>
				{/if}
				<span
					class="rounded-full px-2 py-0.5 text-xs {hasViolations ? 'bg-red-900/40 text-red-400' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}"
					title={hasViolations ? "Clear security violations first" : ""}
				>
					{ext.enabled ? "Enabled" : "Disabled"}
				</span>
			</div>
		</div>

		{#if successMsg}
			<div class="rounded-lg bg-green-900/40 px-4 py-2 text-sm text-green-300">{successMsg}</div>
		{/if}
		{#if errorMsg}
			<div class="rounded-lg bg-red-900/40 px-4 py-2 text-sm text-red-400">{errorMsg}</div>
		{/if}
		{#if expiredGrantsError}
			<div class="rounded-lg bg-amber-900/40 px-4 py-2 text-xs text-amber-300" data-testid="expired-grants-error">
				{expiredGrantsError}
			</div>
		{/if}

		<!--
			Phase 4 (capability-expiry) — recently-expired grants banner.
			Renders nothing if there are no rows. Click → opens the inline
			re-approve modal below.
		-->
		<ExpiredGrantsBanner
			expiredGrants={expiredGrants}
			isAdmin={isAdmin}
			onReapprove={handleReapproveOpen}
		/>

		{#if reapproveModal && ext}
			<ExpiredReapproveModal
				extensionName={ext.name}
				capability={reapproveModal.capability}
				ageMs={reapproveModal.ageMs}
				initialTtlMs={reapproveModal.stickyTtlMs ?? DEFAULT_TTL_FIRST_USE_MS}
				isAdmin={isAdmin}
				loading={reapproveSubmitting}
				onApproveDefault={(ttlOverrideMs) =>
					handleReapproveSubmit(undefined, ttlOverrideMs)}
				onApproveForever={() => handleReapproveSubmit("forever")}
				onCancel={handleReapproveCancel}
			/>
		{/if}

		<!-- Security Violations -->
		{#if hasViolations}
			<div class="rounded-lg border border-red-800 bg-red-900/30 p-4">
				<h3 class="text-sm font-semibold text-red-300">Security Violations</h3>
				<p class="mt-1 text-xs text-red-400/80">
					This extension was disabled due to security violations. Review and clear them to re-enable.
				</p>
				<ul class="mt-3 space-y-2">
					{#each violations as v}
						<li class="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm">
							<strong class="text-red-300">{v.reason}</strong>
							<span class="ml-2 font-mono text-xs text-red-400/70">{v.path}</span>
							<span class="ml-2 text-xs text-[var(--color-text-muted)]">{relativeTime(v.timestamp)}</span>
						</li>
					{/each}
				</ul>
				{#if isAdmin}
					<button
						onclick={clearViolations}
						disabled={clearingViolations}
						class="mt-3 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
					>
						{clearingViolations ? "Clearing..." : "Clear Violations"}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Info -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">Details</h3>
			<dl class="grid grid-cols-2 gap-2 text-sm">
				<dt class="text-[var(--color-text-muted)]">Source</dt>
				<dd class="text-[var(--color-text-secondary)]">{ext.source}</dd>
				<dt class="text-[var(--color-text-muted)]">Entrypoint</dt>
				<dd class="font-mono text-[var(--color-text-secondary)]">{ext.manifest.entrypoint}</dd>
				<dt class="text-[var(--color-text-muted)]">Persistent</dt>
				<dd class="text-[var(--color-text-secondary)]">{ext.manifest.persistent ? "Yes" : "No"}</dd>
				<dt class="text-[var(--color-text-muted)]">Install Path</dt>
				<dd class="font-mono text-xs text-[var(--color-text-secondary)]">{ext.installPath}</dd>
			</dl>

			<!-- MCP Connection panel (Phase 3/B). Renders only for kind:"mcp".
			     Shows transport + command/url + header KEYS (never values), and
			     an Edit-connection panel that "Test & Save"s via PUT. -->
			{#if isMcp && mcpServer}
				{@const s = mcpServer}
				<div class="mt-4 border-t border-[var(--color-border)] pt-4" data-testid="mcp-connection-panel">
					<div class="mb-2 flex items-center justify-between">
						<h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">Connection</h4>
						{#if !mcpEditOpen}
							<button
								onclick={openMcpEdit}
								data-testid="mcp-edit-connection-button"
								class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
							>
								Edit connection
							</button>
						{/if}
					</div>

					{#if !mcpEditOpen}
						<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
							<dt class="text-[var(--color-text-muted)]">Transport</dt>
							<dd class="text-[var(--color-text-secondary)]" data-testid="mcp-connection-transport">{s.transport}</dd>
							{#if s.transport === "stdio"}
								<dt class="text-[var(--color-text-muted)]">Command</dt>
								<dd class="font-mono text-xs text-[var(--color-text-secondary)] break-all" data-testid="mcp-connection-command">{s.command}{s.args?.length ? " " + s.args.join(" ") : ""}</dd>
							{:else}
								<dt class="text-[var(--color-text-muted)]">URL</dt>
								<dd class="font-mono text-xs text-[var(--color-text-secondary)] break-all" data-testid="mcp-connection-url">{s.url}</dd>
								<dt class="text-[var(--color-text-muted)]">Headers</dt>
								<dd class="text-xs text-[var(--color-text-secondary)]" data-testid="mcp-connection-headers">
									{#if Object.keys(s.headers ?? {}).length}
										{#each Object.keys(s.headers ?? {}) as key}
											<code class="mr-1 rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5">{key}</code>
										{/each}
									{:else}
										<span class="text-[var(--color-text-muted)]">None</span>
									{/if}
								</dd>
							{/if}
						</dl>
						{#if mcpToolDelta && (mcpToolDelta.added.length || mcpToolDelta.removed.length)}
							<div class="mt-2 rounded-md border border-blue-800/60 bg-blue-900/20 px-3 py-2 text-xs text-blue-200" data-testid="mcp-tool-delta">
								{#if mcpToolDelta.added.length}
									<div><span class="font-medium text-green-300">+{mcpToolDelta.added.length}</span> added: {mcpToolDelta.added.join(", ")}</div>
								{/if}
								{#if mcpToolDelta.removed.length}
									<div><span class="font-medium text-red-300">-{mcpToolDelta.removed.length}</span> removed: {mcpToolDelta.removed.join(", ")}</div>
								{/if}
							</div>
						{/if}
					{:else}
						<!-- Edit panel — install field set, pre-filled. -->
						<div class="space-y-2" data-testid="mcp-edit-panel">
							<input
								type="text"
								bind:value={mcpDescription}
								placeholder="Description (optional)"
								class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
							/>
							<div class="flex gap-2">
								<select
									bind:value={mcpTransport}
									data-testid="mcp-edit-transport"
									class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
								>
									<option value="stdio">stdio</option>
									<option value="http">Streamable HTTP</option>
									<option value="sse">SSE (legacy)</option>
								</select>
								{#if mcpTransport === "stdio"}
									<input
										type="text"
										bind:value={mcpCommand}
										data-testid="mcp-edit-command"
										placeholder="command (e.g. npx)"
										class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
									/>
									<input
										type="text"
										bind:value={mcpArgs}
										data-testid="mcp-edit-args"
										placeholder="args (space-separated)"
										class="flex-[2] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
									/>
								{:else}
									<input
										type="text"
										bind:value={mcpUrl}
										data-testid="mcp-edit-url"
										placeholder="https://example.com/mcp"
										class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
									/>
								{/if}
							</div>
							{#if mcpTransport !== "stdio"}
								<textarea
									bind:value={mcpHeaders}
									data-testid="mcp-edit-headers"
									placeholder="Headers (one per line). Leave a value blank to keep the existing secret."
									rows="2"
									class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
								></textarea>
							{/if}
							<div class="flex justify-end gap-2">
								<button
									onclick={() => (mcpEditOpen = false)}
									disabled={mcpSaving}
									class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
								>
									Cancel
								</button>
								<button
									onclick={saveMcpEdit}
									disabled={mcpSaving}
									data-testid="mcp-test-save-button"
									class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
								>
									{mcpSaving ? "Testing…" : "Test & Save"}
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!--
			Per-project integration surface (github-projects only). Unlike every
			other extension, github-projects is configured per EZCorp project —
			connecting a board lives at /project/<id>/integrations/github-projects,
			NOT in the single global Settings panel below. This section is the
			discoverable entry point to that surface (the top-level nav item was
			removed).
		-->
		{#if isGithubProjects}
			<div
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
				data-testid="extension-integration-section"
			>
				<h3 class="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">Per-project board connection</h3>
				<p class="mb-3 text-xs text-[var(--color-text-muted)]">
					This extension is configured per project. Connect a GitHub Projects board to
					the active project to map columns to AI agent runs.
				</p>
				<a
					href={ghProjectsConnectHref}
					data-testid="extension-connect-board-link"
					class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-accent)] hover:bg-[var(--color-surface-tertiary)]"
				>
					Connect a board per project →
				</a>
			</div>
		{/if}

		<!-- Tools -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">
				Tools ({ext.manifest.tools?.length ?? 0})
			</h3>
			{#if !ext.manifest.tools?.length}
				<p class="text-sm text-[var(--color-text-muted)]">No tools defined</p>
			{:else}
				<div class="space-y-3">
					{#each ext.manifest.tools ?? [] as tool}
						{@const hasSchema = tool.inputSchema && Object.keys(tool.inputSchema).length > 0}
						{#if hasSchema}
							<details class="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3">
								<summary class="-m-3 cursor-pointer list-none rounded-md p-3 hover:bg-[var(--color-surface-tertiary)]/40">
									<div class="flex items-start justify-between gap-2">
										<div class="min-w-0">
											<h4 class="font-mono text-sm font-medium text-blue-400">{tool.name}</h4>
											<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{tool.description}</p>
										</div>
										<span class="mt-0.5 text-xs text-[var(--color-text-muted)] transition-transform group-open:rotate-90" aria-hidden="true">▶</span>
									</div>
								</summary>
								<div class="mt-3">
								<JsonBlock value={tool.inputSchema} />
							</div>
							</details>
						{:else}
							<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3">
								<h4 class="font-mono text-sm font-medium text-blue-400">{tool.name}</h4>
								<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{tool.description}</p>
							</div>
						{/if}
					{/each}
				</div>
			{/if}

			<!-- Phase 4 — read-only "Uses" chips from manifest.dependencies
			     (renders nothing when the extension declares no deps). -->
			<UsesList dependencies={ext.manifest.dependencies} />
		</div>

		<!-- Hub Pages (Extension Pages Hub) — declaring a page IS the grant,
		     so this section is where the user sees what the extension adds
		     to /hub (the install flow auto-approves; there is no separate
		     review dialog to surface it in). -->
		{#if ext.manifest.pages?.length}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4" data-testid="extension-pages-section">
				<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">
					Hub Pages ({ext.manifest.pages.length})
				</h3>
				<div class="space-y-2">
					{#each ext.manifest.pages as page}
						{#if ext.enabled}
							<!-- Whole card is the click target → project-scoped hub
							     route. Normal pushState <a> so Back returns here. -->
							<a
								href={`/project/${hubProjectId}/hub/${encodeURIComponent(`ext:${ext.name}:${page.id}`)}`}
								class="block rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3 transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-tertiary)]"
								data-testid="extension-page-link"
							>
								<div class="flex items-center justify-between gap-2">
									<h4 class="text-sm font-medium text-[var(--color-text-primary)]">{page.title}</h4>
									<span class="shrink-0 text-xs text-[var(--color-accent)]">Open in Hub →</span>
								</div>
								{#if page.description}
									<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{page.description}</p>
								{/if}
							</a>
						{:else}
							<!-- Disabled extension: pages stay listed but the tab
							     would 404, so the card is not a link. -->
							<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3">
								<h4 class="text-sm font-medium text-[var(--color-text-primary)]">{page.title}</h4>
								{#if page.description}
									<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{page.description}</p>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<!-- Settings (Slice 4) -->
		<section
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
			data-testid="extension-settings-section"
		>
			<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Settings</h3>

			{#if settingsError}
				<p class="mb-3 text-xs text-red-400">{settingsError}</p>
			{/if}

			<!-- §5.2 host-capability policy (admin ceiling) — rendered
			     ABOVE the per-user settings. Only shows for extensions that
			     HOLD a host capability (search). The per-user settings
			     section below is unaffected by capability changes. -->
			{#if settingsLoaded && capabilities.length > 0}
				<div class="mb-4">
					<CapabilitiesPanel {capabilities} {isAdmin} onsave={saveCapabilityGrant} />
				</div>
			{/if}

			{#if !settingsLoaded}
				<p class="text-xs text-[var(--color-text-muted)]">Loading settings…</p>
			{:else if !hasSchema}
				<p class="text-xs text-[var(--color-text-muted)]" data-testid="extension-settings-empty">
					This extension declares no settings.
				</p>
			{:else}
				<SettingsPanel
					title="Your settings"
					schema={settingsSchema}
					values={userValues}
					canReset={true}
					onsave={saveUserSettings}
					onreset={resetUserSettings}
					testid="settings-panel-user"
				/>
			{/if}

			<!-- Modification gate. Lives inside the Settings section
			     (no separate top-of-page banner). `ext` is already
			     guaranteed truthy here (this section is within the page
			     body's ext scope and references ext.manifest below), so
			     no redundant {#if ext} guard. Handlers/state are the
			     shared reopenForEdit/toggleModifiable — nothing duped. -->
			<div
				class="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4"
				data-testid="modify-extension-section"
			>
				{#if ext.creatorUserId && ext.creatorUserId === currentUserId && ext.modifiable}
					<button
						onclick={reopenForEdit}
						disabled={modifyBusy}
						data-testid="modify-extension-button"
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
					>
						{modifyBusy ? "Opening…" : "Modify this extension"}
					</button>
					<span class="text-xs text-[var(--color-text-secondary)]">
						Re-opens your extension as an editable draft.
					</span>
				{:else if ext.creatorUserId && ext.creatorUserId === currentUserId}
					<span class="text-xs text-[var(--color-text-secondary)]">
						You created this extension. An admin must enable
						modification before you can edit it.
					</span>
				{/if}

				<!-- Always shown, for EVERY extension. Interactive only for
				     an admin on a non-bundled extension. Bundled (built-in)
				     extensions are shipped first-party and can never be
				     made modifiable — the box is shown disabled with an
				     explanation rather than the row silently vanishing.
				     Server enforces the same rules (requireRole admin +
				     400 for bundled); this is purely the affordance. -->
				<label
					class="ml-auto flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"
					title={ext.isBundled
						? "Built-in extensions can't be made modifiable"
						: isAdmin
							? ""
							: "Only an admin can change this"}
				>
					<input
						type="checkbox"
						checked={ext.modifiable ?? false}
						disabled={modifiableBusy || !isAdmin || ext.isBundled}
						onchange={toggleModifiable}
						data-testid="modifiable-toggle"
					/>
					<span class:line-through={ext.isBundled}
						>Allow extension to be modified</span
					>
					{#if ext.isBundled}
						<span class="text-[var(--color-text-tertiary)]"
							>(built-in — not modifiable)</span
						>
					{:else if !isAdmin}
						<span class="text-[var(--color-text-tertiary)]">(admin only)</span>
					{/if}
				</label>
			</div>
		</section>

		<!-- Entities (Phase 5 — defineEntity SDK).
			 One auto-table section per declared entity type. The
			 EntityTable component is self-contained: it owns its own
			 fetch loop + modal state and writes through the
			 /api/extensions/[id]/entities/[type] routes. -->
		{#if ext.manifest.entities && ext.manifest.entities.length > 0}
			{#each ext.manifest.entities as decl (decl.type)}
				{#if (decl.scope ?? 'user') !== 'conversation'}
					<EntityTable extensionId={ext.id} decl={decl as never} />
				{/if}
			{/each}
		{/if}

		<!-- Permissions -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Permissions</h3>

			<div class="space-y-3">
				<!-- Network -->
				<div>
					<div class="text-xs font-medium text-[var(--color-text-secondary)]">Network Access</div>
					<div class="mt-1 flex flex-wrap gap-1">
						{#each ext.manifest.permissions.network ?? [] as domain}
							<label class="flex items-center gap-1 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
								<input
									type="checkbox"
									checked={editPerms.network.includes(domain)}
									onchange={() => {
										if (editPerms.network.includes(domain)) {
											editPerms.network = editPerms.network.filter((d) => d !== domain);
										} else {
											editPerms.network = [...editPerms.network, domain];
										}
									}}
									class="h-3 w-3"
								/>
								{domain}
							</label>
						{/each}
						{#if !ext.manifest.permissions.network?.length}
							<span class="text-xs text-[var(--color-text-muted)]">None requested</span>
						{/if}
					</div>
				</div>

				<!-- Filesystem -->
				<div>
					<div class="text-xs font-medium text-[var(--color-text-secondary)]">Filesystem Access</div>
					<div class="mt-1 flex flex-wrap gap-1">
						{#each ext.manifest.permissions.filesystem ?? [] as path}
							<label class="flex items-center gap-1 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
								<input
									type="checkbox"
									checked={editPerms.filesystem.includes(path)}
									onchange={() => {
										if (editPerms.filesystem.includes(path)) {
											editPerms.filesystem = editPerms.filesystem.filter((p) => p !== path);
										} else {
											editPerms.filesystem = [...editPerms.filesystem, path];
										}
									}}
									class="h-3 w-3"
								/>
								{path}
							</label>
						{/each}
						{#if !ext.manifest.permissions.filesystem?.length}
							<span class="text-xs text-[var(--color-text-muted)]">None requested</span>
						{/if}
					</div>
				</div>

				<!-- Shell -->
				<div>
					<label class="flex items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)]">
						<input
							type="checkbox"
							checked={editPerms.shell}
							onchange={() => (editPerms.shell = !editPerms.shell)}
							class="h-3 w-3"
						/>
						Shell Access
						{#if ext.manifest.permissions.shell}
							<span class="rounded bg-red-900/40 px-1 py-0.5 text-xs text-red-400">Requested</span>
						{/if}
					</label>
				</div>

				<!-- Env -->
				<div>
					<div class="text-xs font-medium text-[var(--color-text-secondary)]">Environment Variables</div>
					<div class="mt-1 flex flex-wrap gap-1">
						{#each ext.manifest.permissions.env ?? [] as varName}
							<label class="flex items-center gap-1 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
								<input
									type="checkbox"
									checked={editPerms.env.includes(varName)}
									onchange={() => {
										if (editPerms.env.includes(varName)) {
											editPerms.env = editPerms.env.filter((v) => v !== varName);
										} else {
											editPerms.env = [...editPerms.env, varName];
										}
									}}
									class="h-3 w-3"
								/>
								{varName}
							</label>
						{/each}
						{#if !ext.manifest.permissions.env?.length}
							<span class="text-xs text-[var(--color-text-muted)]">None requested</span>
						{/if}
					</div>
				</div>

				<!--
					Phase 4 deputy / orchestration consent. Each renders only
					when the manifest actually declares the flag (the runtime
					gate also requires the user's acceptance, so the
					checkbox state is the source of truth at install time).
				-->
				{#if ext.manifest.acceptsCallerCaps === true}
					<div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
						<label class="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
							<input
								type="checkbox"
								checked={editPerms.acceptsCallerCaps}
								onchange={() => (editPerms.acceptsCallerCaps = !editPerms.acceptsCallerCaps)}
								class="mt-0.5 h-3 w-3"
							/>
							<span>
								<span class="font-medium text-amber-300">Accept caller capabilities (deputy)</span>
								<span class="ml-2 rounded bg-amber-900/40 px-1 py-0.5 text-xs text-amber-300">Elevated trust</span>
								<div class="mt-1 text-[var(--color-text-muted)]">
									This extension's tools run with the
									intersection of the calling extension's
									capabilities and its own. Deny if you
									don't expect this extension to act as a
									deputy for other extensions via
									<code>ezcorp/invoke</code>.
								</div>
							</span>
						</label>
					</div>
				{/if}
				{#if ext.manifest.escalateChildCaps === true}
					<div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
						<label class="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
							<input
								type="checkbox"
								checked={editPerms.escalateChildCaps}
								onchange={() => (editPerms.escalateChildCaps = !editPerms.escalateChildCaps)}
								class="mt-0.5 h-3 w-3"
							/>
							<span>
								<span class="font-medium text-amber-300">Escalate child capabilities (orchestrator)</span>
								<span class="ml-2 rounded bg-amber-900/40 px-1 py-0.5 text-xs text-amber-300">Elevated trust</span>
								<div class="mt-1 text-[var(--color-text-muted)]">
									Sub-conversations spawned by this
									extension are NOT capped by your
									conversation's capabilities — they run
									with the spawned extension's own
									installed grants. Only enable for
									dedicated orchestration extensions.
								</div>
							</span>
						</label>
					</div>
				{/if}
			</div>

			<button
				onclick={savePermissions}
				disabled={saving}
				class="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
			>
				{saving ? "Saving..." : "Save Permissions"}
			</button>
		</div>

		<!-- Sensitive Operations -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Sensitive Operations</h3>
			<p class="mb-3 text-xs text-[var(--color-text-muted)]">
				Control whether this extension can bypass confirmation dialogs for sensitive operations.
			</p>
			<div class="space-y-2">
				<label class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
					<input
						type="checkbox"
						checked={alwaysAllowShell}
						onchange={() => toggleAlwaysAllow("shell", alwaysAllowShell)}
						class="h-4 w-4"
					/>
					Always allow shell commands
				</label>
				<label class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
					<input
						type="checkbox"
						checked={alwaysAllowFs}
						onchange={() => toggleAlwaysAllow("filesystem", alwaysAllowFs)}
						class="h-4 w-4"
					/>
					Always allow filesystem writes
				</label>
			</div>
		</div>

		<!-- Test placeholder -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-2 text-sm font-medium text-[var(--color-text-muted)]">Testing</h3>
			<p class="text-xs text-[var(--color-text-muted)]">Tool testing will be available after Plan 07-04 is implemented.</p>
		</div>

		<!-- Permission-change audit trail (S8 in the Phase 1 plan) -->
		{#if isAdmin}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
				<h3 class="mb-2 text-sm font-medium text-[var(--color-text-muted)]">Audit Trail</h3>
				<p class="mb-3 text-xs text-[var(--color-text-muted)]">
					Every permission grant, revoke, or rejected attempt is recorded here. System rows capture automatic grants (bundled-install, bundled-regrant, drift detection, blocked version bumps).
				</p>
				{#if auditLoading}
					<p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
				{:else if auditError}
					<p class="text-xs text-red-500">{auditError}</p>
				{:else if auditEntries.length === 0}
					<p class="text-xs text-[var(--color-text-muted)]">No audit entries yet for this extension.</p>
				{:else}
					<ul class="space-y-2 text-xs">
						{#each auditEntries as entry (entry.id)}
							<li class="flex items-start gap-2 border-l-2 border-[var(--color-border)] pl-2">
								<span class="font-mono text-[var(--color-text-muted)]">{relativeTime(entry.createdAt)}</span>
								<span class="font-medium">{shortActor(entry.userId, entry.metadata)}</span>
								<span class="text-[var(--color-text)]">{auditSummary(entry)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
</div>
