<script lang="ts">
	import { page } from "$app/stores";
	import { onMount } from "svelte";

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
		manifest: {
			author?: string;
			entrypoint: string;
			persistent?: boolean;
			tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
			permissions: {
				network?: string[];
				filesystem?: string[];
				shell?: boolean;
				env?: string[];
			};
		};
		grantedPermissions: {
			network?: string[];
			filesystem?: string[];
			shell?: boolean;
			env?: string[];
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
	}>({ network: [], filesystem: [], shell: false, env: [] });

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
	let clearingViolations = $state(false);

	const extId = $derived($page.params.id);
	const hasViolations = $derived(violations.length > 0);

	async function checkAdmin() {
		try {
			const res = await fetch("/api/auth/me");
			if (res.ok) {
				const data = await res.json();
				if (data.user?.role === "admin") isAdmin = true;
			}
		} catch {
			// not admin
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
				};
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to load extension";
		} finally {
			loading = false;
		}
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
		await Promise.all([loadExtension(), loadViolations(), loadAuditTrail()]);
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
				<p class="text-sm text-[var(--color-text-secondary)]">v{ext.version}{ext.manifest.author ? ` by ${ext.manifest.author}` : ""}</p>
				<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{ext.description}</p>
			</div>
			<div class="flex items-center gap-3">
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
		</div>

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
						<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3">
							<h4 class="font-mono text-sm font-medium text-blue-400">{tool.name}</h4>
							<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{tool.description}</p>
							{#if tool.inputSchema && Object.keys(tool.inputSchema).length > 0}
								<details class="mt-2">
									<summary class="cursor-pointer text-xs text-[var(--color-text-muted)]">Input Schema</summary>
									<pre class="mt-1 overflow-x-auto rounded bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-secondary)]">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
								</details>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Permissions -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Permissions</h3>

			<div class="space-y-3">
				<!-- Network -->
				<div>
					<label class="text-xs font-medium text-[var(--color-text-secondary)]">Network Access</label>
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
					<label class="text-xs font-medium text-[var(--color-text-secondary)]">Filesystem Access</label>
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
					<label class="text-xs font-medium text-[var(--color-text-secondary)]">Environment Variables</label>
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
