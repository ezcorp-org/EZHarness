<script lang="ts">
	import { onMount } from "svelte";
	import { addToast } from "$lib/toast.svelte.js";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import {
		ACTIVE_TAB_STORAGE_KEY,
		type LibraryTab,
		readActiveTab,
		writeActiveTab,
	} from "$lib/extensions/library-tabs";

	interface PageData {
		bundledExtensions: ExtensionRecord[];
		installedExtensions: ExtensionRecord[];
	}
	const { data }: { data: PageData } = $props();

	interface ExtensionRecord {
		id: string;
		name: string;
		version: string;
		description: string;
		enabled: boolean;
		source: string;
		consecutiveFailures: number;
		manifest: {
			kind?: "local" | "mcp";
			tools: Array<{ name: string; description: string }>;
			mcpServers?: Array<
				| { transport: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string> }
				| { transport: "http"; name: string; url: string; headers?: Record<string, string> }
				| { transport: "sse"; name: string; url: string; headers?: Record<string, string> }
			>;
			permissions: {
				network?: string[];
				filesystem?: string[];
				shell?: boolean;
				env?: string[];
				storage?: boolean;
				lifecycleHooks?: boolean;
				// Capability tier (Phase 2+) — see src/extensions/types.ts
				taskEvents?: boolean;
				spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
				agentConfig?: "read";
			};
			lifecycleHooks?: string[];
		};
		grantedPermissions: Record<string, unknown>;
		isBundled?: boolean;
	}

	interface ReviewSelection {
		network: Record<string, boolean>;
		filesystem: Record<string, boolean>;
		shell: boolean;
		env: Record<string, boolean>;
		storage: boolean;
		// Capability tier (Phase 2+)
		taskEvents: boolean;
		spawnAgents: boolean; // single toggle — declaring the manifest grant means accepting the declared caps
		agentConfig: boolean;
	}

	// SSR-loaded so the first paint already shows cards. `loadExtensions()`
	// re-fetches via the existing `/api/extensions` endpoint after any
	// mutation, replacing both lists from a single response keyed by
	// `isBundled`.
	let extensions = $state<ExtensionRecord[]>([
		...data.bundledExtensions,
		...data.installedExtensions,
	]);
	let loading = $state(false);
	let errorMsg = $state("");
	// Library tab state — persisted to localStorage via library-tabs helper.
	// Default "installed" preserves prior behavior for users with no
	// built-ins (Phase 53 ships them).
	let activeTab = $state<LibraryTab>("installed");
	// Filtered views over `extensions` — both tabs share the install form
	// and the auto-disabled banner, but show only the cards belonging to
	// the active tab.
	let bundledExtensions = $derived(extensions.filter((e) => e.isBundled === true));
	let installedExtensions = $derived(extensions.filter((e) => e.isBundled !== true));
	let visibleExtensions = $derived(
		activeTab === "builtins" ? bundledExtensions : installedExtensions,
	);

	// Install form state
	let installMode = $state<"local" | "github" | "git" | "mcp">("local");
	let localPath = $state("");
	let githubRepo = $state("");
	let gitUrl = $state("");
	let gitRef = $state("");
	let installing = $state(false);

	// MCP install form state
	let mcpName = $state("");
	let mcpDescription = $state("");
	let mcpTransport = $state<"stdio" | "http" | "sse">("stdio");
	let mcpCommand = $state("");
	let mcpArgs = $state(""); // space-separated on input; converted on submit
	let mcpUrl = $state("");
	let mcpHeaders = $state(""); // one "Key: value" per line

	// Permission review dialog — open when the admin enables an extension
	let reviewExt = $state<ExtensionRecord | null>(null);
	let reviewSelection = $state<ReviewSelection>({
		network: {},
		filesystem: {},
		shell: false,
		env: {},
		storage: false,
		taskEvents: false,
		spawnAgents: false,
		agentConfig: false,
	});
	let activating = $state(false);

	// Uninstall confirmation
	let confirmDeleteId = $state<string | null>(null);

	async function loadExtensions() {
		try {
			const res = await fetch("/api/extensions", { cache: "no-store" });
			extensions = await res.json();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Failed to load extensions" });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// Restore the persisted tab BEFORE the first fetch so the SSR rows
		// render in the correct tab on first paint when the user has it
		// pinned to "builtins". `readActiveTab` handles SSR-safety + bad
		// JSON; default is "installed".
		activeTab = readActiveTab();
		void loadExtensions();
	});

	function selectTab(tab: LibraryTab) {
		activeTab = tab;
		writeActiveTab(tab);
	}

	// Pull a human-readable error out of a non-OK Response. Handles both
	// `{error}` and `{message}` shapes, appends zod-style `fields`, and falls
	// back to statusText when the body is empty/unparseable — otherwise a
	// bad-JSON body would surface a parser error rather than the real cause.
	async function extractError(res: Response, fallback: string): Promise<string> {
		const text = await res.text().catch(() => "");
		if (text) {
			try {
				const data = JSON.parse(text);
				let msg = (data && (data.error || data.message)) as string | undefined;
				if (data && data.fields && typeof data.fields === "object") {
					const fieldPairs = Object.entries(data.fields)
						.map(([k, v]) => `${k}: ${v}`)
						.join("; ");
					msg = msg ? `${msg} — ${fieldPairs}` : fieldPairs;
				}
				if (msg) return msg;
			} catch {
				if (text.length < 200) return text;
			}
		}
		return res.statusText || fallback;
	}

	async function startInstall() {
		errorMsg = "";
		if (installMode === "local" && !localPath.trim()) {
			errorMsg = "Please enter a local path";
			return;
		}
		if (installMode === "github" && !githubRepo.trim()) {
			errorMsg = "Please enter a GitHub repo (user/repo)";
			return;
		}
		if (installMode === "git" && !gitUrl.trim()) {
			errorMsg = "Please enter a git URL (https:// or git@host:owner/repo)";
			return;
		}
		if (installMode === "mcp") {
			return startMcpInstall();
		}

		// For simplicity, approve all requested permissions on install
		// A more advanced flow would show a review dialog
		installing = true;
		try {
			const body: Record<string, unknown> = {
				source: installMode,
				permissions: { grantedAt: { install: Date.now() } },
			};
			if (installMode === "local") body.path = localPath.trim();
			else if (installMode === "github") body.repo = githubRepo.trim();
			else {
				body.url = gitUrl.trim();
				if (gitRef.trim()) body.ref = gitRef.trim();
			}

			const res = await fetch("/api/extensions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				throw new Error(await extractError(res, "Install failed"));
			}

			localPath = "";
			githubRepo = "";
			gitUrl = "";
			gitRef = "";
			addToast({ type: "success", message: "Extension installed successfully" });
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Install failed" });
		} finally {
			installing = false;
		}
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

	async function startMcpInstall() {
		errorMsg = "";
		if (!mcpName.trim()) {
			errorMsg = "Extension name is required";
			return;
		}
		let server: Record<string, unknown>;
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
			const headers = parseHeaders(mcpHeaders);
			server = { transport: mcpTransport, name: mcpName.trim(), url: mcpUrl.trim(), headers };
		}

		installing = true;
		try {
			const res = await fetch("/api/mcp-servers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: mcpName.trim(),
					description: mcpDescription.trim(),
					server,
				}),
			});
			if (!res.ok) {
				throw new Error(await extractError(res, "MCP install failed"));
			}
			mcpName = "";
			mcpDescription = "";
			mcpCommand = "";
			mcpArgs = "";
			mcpUrl = "";
			mcpHeaders = "";
			addToast({ type: "success", message: "MCP server connected" });
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "MCP install failed" });
		} finally {
			installing = false;
		}
	}

	async function refreshMcp(id: string) {
		try {
			const res = await fetch(`/api/mcp-servers/${id}/refresh`, { method: "POST" });
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || "Refresh failed");
			}
			addToast({ type: "success", message: "MCP tools refreshed" });
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Refresh failed" });
		}
	}

	async function toggleEnabled(ext: ExtensionRecord) {
		if (!ext.enabled) {
			openReview(ext);
			return;
		}
		try {
			const res = await fetch(`/api/extensions/${ext.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || "Failed to update");
			}
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Update failed" });
		}
	}

	function openReview(ext: ExtensionRecord) {
		const perms = ext.manifest.permissions ?? {};
		reviewSelection = {
			network: Object.fromEntries((perms.network ?? []).map((d) => [d, true])),
			filesystem: Object.fromEntries((perms.filesystem ?? []).map((p) => [p, true])),
			shell: perms.shell === true,
			env: Object.fromEntries((perms.env ?? []).map((v) => [v, true])),
			storage: perms.storage === true,
			// Capability-tier toggles default ON when declared — admin MUST
			// uncheck to deny. This matches the existing convention for
			// storage/shell, and the red-banner text on `spawnAgents` makes
			// the opt-out obvious.
			taskEvents: perms.taskEvents === true,
			spawnAgents: !!perms.spawnAgents,
			agentConfig: perms.agentConfig === "read",
		};
		reviewExt = ext;
	}

	function cancelReview() {
		reviewExt = null;
		activating = false;
	}

	function hasAnyManifestPerm(ext: ExtensionRecord): boolean {
		const p = ext.manifest.permissions ?? {};
		return Boolean(
			p.network?.length ||
			p.filesystem?.length ||
			p.shell ||
			p.env?.length ||
			p.storage ||
			p.lifecycleHooks ||
			p.taskEvents ||
			p.spawnAgents ||
			p.agentConfig,
		);
	}

	async function confirmActivate() {
		if (!reviewExt) return;
		activating = true;
		const now = Date.now();
		const granted: Record<string, unknown> = { grantedAt: {} };
		const grantedAt = granted.grantedAt as Record<string, number>;

		const network = Object.entries(reviewSelection.network).filter(([, v]) => v).map(([k]) => k);
		if (network.length) {
			granted.network = network;
			grantedAt.network = now;
		}
		const filesystem = Object.entries(reviewSelection.filesystem).filter(([, v]) => v).map(([k]) => k);
		if (filesystem.length) {
			granted.filesystem = filesystem;
			grantedAt.filesystem = now;
		}
		if (reviewSelection.shell) {
			granted.shell = true;
			grantedAt.shell = now;
		}
		const env = Object.entries(reviewSelection.env).filter(([, v]) => v).map(([k]) => k);
		if (env.length) {
			granted.env = env;
			grantedAt.env = now;
		}
		if (reviewSelection.storage) {
			granted.storage = true;
			grantedAt.storage = now;
		}
		// Capability tier — only send if the admin left the toggle on AND
		// the manifest declared the field. Activate endpoint's clamp
		// re-enforces both checks server-side; sending forged values here
		// would be dropped, but we also prune client-side for clarity.
		const manifestPerms = reviewExt.manifest.permissions ?? {};
		if (reviewSelection.taskEvents && manifestPerms.taskEvents) {
			granted.taskEvents = true;
			grantedAt.taskEvents = now;
		}
		if (reviewSelection.spawnAgents && manifestPerms.spawnAgents) {
			granted.spawnAgents = {
				maxPerHour: manifestPerms.spawnAgents.maxPerHour,
				maxConcurrent: manifestPerms.spawnAgents.maxConcurrent ?? 3,
			};
			grantedAt.spawnAgents = now;
		}
		if (reviewSelection.agentConfig && manifestPerms.agentConfig === "read") {
			granted.agentConfig = "read";
			grantedAt.agentConfig = now;
		}
		grantedAt.install = now;

		const id = reviewExt.id;
		try {
			const res = await fetch(`/api/extensions/${id}/activate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ grantedPermissions: granted }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || "Activation failed");
			}
			reviewExt = null;
			addToast({ type: "success", message: "Extension activated" });
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Activation failed" });
		} finally {
			activating = false;
		}
	}

	async function uninstall(id: string) {
		try {
			const res = await fetch(`/api/extensions/${id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 204) throw new Error("Failed to uninstall");
			confirmDeleteId = null;
			addToast({ type: "success", message: "Extension uninstalled" });
			await loadExtensions();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Uninstall failed" });
		}
	}

	function permissionIcons(perms: ExtensionRecord["manifest"]["permissions"] | undefined) {
		if (!perms) return [];
		const icons: string[] = [];
		if (perms.network?.length) icons.push("network");
		if (perms.filesystem?.length) icons.push("filesystem");
		if (perms.shell) icons.push("shell");
		if (perms.env?.length) icons.push("env");
		return icons;
	}

	const autoDisabled = $derived(extensions.filter((e) => !e.enabled && e.consecutiveFailures >= 3));
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Extensions</h2>
		<a
			href="https://github.com/ezcorp-org/ezcorp/blob/main/docs/extensions/getting-started.md"
			target="_blank"
			rel="noopener noreferrer"
			class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
		>
			Create your own &rarr;
		</a>
	</div>

	<!-- Auto-disabled notification -->
	{#each autoDisabled as ext}
		<div class="rounded-lg border border-amber-800 bg-amber-900/30 px-4 py-3 text-sm text-amber-200">
			<span class="font-medium">{ext.name}</span> was disabled after {ext.consecutiveFailures} failures.
			<button
				onclick={() => toggleEnabled(ext)}
				class="ml-2 underline hover:text-amber-100"
			>
				Re-enable
			</button>
		</div>
	{/each}

	<!-- Form validation error (inline, not toast) -->
	{#if errorMsg}
		<div class="rounded-lg bg-red-900/40 px-4 py-2 text-sm text-red-400">{errorMsg}</div>
	{/if}

	<!-- Install Section -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
		<h3 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Install Extension</h3>
		<div class="mb-3 flex gap-2">
			<button
				onclick={() => (installMode = "local")}
				class="rounded-md px-3 py-1.5 text-sm transition-colors {installMode === 'local' ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				Local Path
			</button>
			<button
				onclick={() => (installMode = "github")}
				class="rounded-md px-3 py-1.5 text-sm transition-colors {installMode === 'github' ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				GitHub
			</button>
			<button
				onclick={() => (installMode = "git")}
				class="rounded-md px-3 py-1.5 text-sm transition-colors {installMode === 'git' ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				Git URL
			</button>
			<button
				onclick={() => (installMode = "mcp")}
				class="rounded-md px-3 py-1.5 text-sm transition-colors {installMode === 'mcp' ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				MCP Server
			</button>
		</div>

		{#if installMode === "local"}
			<div class="flex gap-2">
				<input
					type="text"
					bind:value={localPath}
					placeholder="/path/to/extension"
					class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
				<button
					onclick={startInstall}
					disabled={installing}
					class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
				>
					{installing ? "Installing..." : "Install"}
				</button>
			</div>
		{:else if installMode === "github"}
			<div class="flex gap-2">
				<input
					type="text"
					bind:value={githubRepo}
					placeholder="user/repo or user/repo@v1.0.0"
					class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
				<button
					onclick={startInstall}
					disabled={installing}
					class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
				>
					{installing ? "Installing..." : "Install from GitHub"}
				</button>
			</div>
		{:else if installMode === "git"}
			<div class="space-y-2">
				<div class="flex gap-2">
					<input
						type="text"
						bind:value={gitUrl}
						placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
						class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<input
						type="text"
						bind:value={gitRef}
						placeholder="ref (optional)"
						class="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<button
						onclick={startInstall}
						disabled={installing}
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
					>
						{installing ? "Installing..." : "Install from Git"}
					</button>
				</div>
				<p class="text-xs text-[var(--color-text-muted)]">
					Clones any branch or tag — no GitHub release required. Accepts http(s) or ssh URLs.
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				<div class="grid grid-cols-2 gap-2">
					<input
						type="text"
						bind:value={mcpName}
						placeholder="Extension name (unique)"
						class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<input
						type="text"
						bind:value={mcpDescription}
						placeholder="Description (optional)"
						class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>
				<div class="flex gap-2">
					<select
						bind:value={mcpTransport}
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
							placeholder="command (e.g. npx)"
							class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
						<input
							type="text"
							bind:value={mcpArgs}
							placeholder="args (space-separated)"
							class="flex-[2] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
					{:else}
						<input
							type="text"
							bind:value={mcpUrl}
							placeholder="https://example.com/mcp"
							class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
					{/if}
				</div>
				{#if mcpTransport !== "stdio"}
					<textarea
						bind:value={mcpHeaders}
						placeholder="Headers (one per line, e.g. Authorization: Bearer ...)"
						rows="2"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					></textarea>
				{/if}
				<div class="flex justify-end">
					<button
						onclick={startInstall}
						disabled={installing}
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
					>
						{installing ? "Connecting..." : "Connect"}
					</button>
				</div>
			</div>
		{/if}
	</div>

	<!-- Library tabs (Phase 52.1) — split Built-ins (`isBundled=true`)
	     from user-Installed extensions. Active tab persists to
	     localStorage via `writeActiveTab`. -->
	<div class="border-b border-[var(--color-border)]">
		<div class="flex gap-2" role="tablist" aria-label="Extensions library">
			<button
				role="tab"
				aria-selected={activeTab === "installed"}
				aria-controls="ext-tab-panel"
				data-testid="ext-tab-installed"
				onclick={() => selectTab("installed")}
				class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'installed' ? 'border-blue-500 text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				Installed <span class="ml-1 text-xs text-[var(--color-text-muted)]">{installedExtensions.length}</span>
			</button>
			<button
				role="tab"
				aria-selected={activeTab === "builtins"}
				aria-controls="ext-tab-panel"
				data-testid="ext-tab-builtins"
				onclick={() => selectTab("builtins")}
				class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'builtins' ? 'border-blue-500 text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				Built-ins <span class="ml-1 text-xs text-[var(--color-text-muted)]">{bundledExtensions.length}</span>
			</button>
		</div>
	</div>

	<!-- Extensions List -->
	<div id="ext-tab-panel" role="tabpanel" data-testid="ext-tab-panel" data-active-tab={activeTab}>
	{#if loading}
		<SkeletonLoader type="card-grid" count={6} />
	{:else if visibleExtensions.length === 0}
		{#if activeTab === "builtins"}
			<EmptyState
				title="No built-in extensions yet"
				description="First-party features ship here in v1.3 Phase 53. Until then, use the Installed tab to add your own."
			>
				{#snippet icon()}
					<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
					</svg>
				{/snippet}
			</EmptyState>
		{:else}
			<EmptyState
				title="No extensions installed"
				description="Extensions add tools and capabilities to your agents. Browse the marketplace to get started."
				ctaLabel="Browse Marketplace"
				ctaHref="/marketplace"
			>
				{#snippet icon()}
					<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a2 2 0 012 2v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a2 2 0 01-2 2h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a2 2 0 01-2-2v-3a1 1 0 00-1-1H3a2 2 0 110-4h1a1 1 0 001-1V8a2 2 0 012-2h3a1 1 0 001-1V4z" />
					</svg>
				{/snippet}
			</EmptyState>
		{/if}
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each visibleExtensions as ext (ext.id)}
				<div
					class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
					data-testid="ext-card"
					data-ext-id={ext.id}
				>
					<div class="mb-2 flex items-start justify-between">
						<a href="/extensions/{ext.id}" class="group">
							<div class="flex items-center gap-2">
								<h3 class="font-medium text-[var(--color-text-primary)] group-hover:text-blue-400">{ext.name}</h3>
								{#if ext.manifest.kind === "mcp"}
									<span class="rounded-full bg-purple-900/50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-purple-200">MCP · {ext.manifest.mcpServers?.[0]?.transport ?? "?"}</span>
								{/if}
								{#if !ext.enabled}
									<span class="rounded-full bg-red-900/50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-red-300">Security Issue</span>
								{/if}
							</div>
							<p class="text-xs text-[var(--color-text-muted)]">v{ext.version}</p>
						</a>
						<button
							onclick={() => toggleEnabled(ext)}
							class="relative h-6 w-11 rounded-full transition-colors {ext.enabled ? 'bg-blue-600' : 'bg-[var(--color-surface-tertiary)]'}"
							title={ext.enabled ? "Disable" : "Enable"}
						>
							<span
								class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform {ext.enabled ? 'left-[22px]' : 'left-0.5'}"
							></span>
						</button>
					</div>

					<p class="mb-3 text-sm text-[var(--color-text-secondary)]">{ext.description || "No description"}</p>

					<div class="flex items-center justify-between">
						<div class="flex gap-2">
							<span class="rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
								{ext.manifest.tools?.length ?? 0} tool{(ext.manifest.tools?.length ?? 0) !== 1 ? "s" : ""}
							</span>
							{#each permissionIcons(ext.manifest.permissions) as icon}
								<span
									class="rounded-full px-2 py-0.5 text-xs {icon === 'shell' ? 'bg-red-900/50 text-red-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}"
									title={icon}
								>
									{icon}
								</span>
							{/each}
						</div>

						<div class="flex gap-1">
							{#if ext.manifest.kind === "mcp"}
								<button
									onclick={() => refreshMcp(ext.id)}
									class="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
									title="Refresh tools list from MCP server"
								>
									Refresh
								</button>
							{/if}
							{#if !ext.isBundled}
								{#if confirmDeleteId === ext.id}
									<button
										onclick={() => uninstall(ext.id)}
										class="rounded-md bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-500"
									>
										Confirm
									</button>
								{:else}
									<button
										onclick={() => { confirmDeleteId = ext.id; setTimeout(() => { if (confirmDeleteId === ext.id) confirmDeleteId = null; }, 3000); }}
										class="rounded-md px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-900/30"
									>
										Uninstall
									</button>
								{/if}
							{:else}
								<!-- Bundled extensions are not user-uninstallable. Settings stay editable. -->
								<span
									class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-muted)]"
									title="Built-in — uninstall is not available"
									data-testid="ext-card-builtin-badge"
								>
									Built-in
								</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
	</div>
</div>

{#if reviewExt}
	{@const ext = reviewExt}
	{@const perms = ext.manifest.permissions ?? {}}
	{@const anyPerms = hasAnyManifestPerm(ext)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onkeydown={(e) => { if (e.key === "Escape") cancelReview(); }}
		onclick={(e) => { if (e.target === e.currentTarget) cancelReview(); }}
	>
		<div class="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<h3 class="text-base font-semibold text-[var(--color-text-primary)]">Review permissions: {ext.name}</h3>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">
				Uncheck any domain, path, or env-var you don't want to grant. Enabling the extension will clamp to this selection.
			</p>

			{#if ext.manifest.kind === "mcp" && ext.manifest.mcpServers?.length}
				<div class="mt-4 rounded-md border border-amber-800 bg-amber-900/30 p-3">
					<h4 class="text-xs font-semibold uppercase tracking-wide text-amber-200">MCP server command</h4>
					<p class="mt-1 text-xs text-amber-200/80">
						Enabling this extension will spawn the following process. The spawn runs under a resource-bounded sandbox, but the binary itself executes with the listed arguments — review carefully.
					</p>
					<div class="mt-2 space-y-2">
						{#each ext.manifest.mcpServers as server}
							<div class="rounded border border-amber-800/60 bg-[var(--color-surface-tertiary)] p-2 text-xs">
								<div class="flex items-center gap-2">
									<span class="text-amber-300/80">transport:</span>
									<code class="rounded bg-black/30 px-1.5 py-0.5 text-amber-100">{server.transport}</code>
									{#if server.name}
										<span class="text-amber-300/80">name:</span>
										<code class="rounded bg-black/30 px-1.5 py-0.5 text-amber-100">{server.name}</code>
									{/if}
								</div>
								{#if server.transport === "stdio"}
									<div class="mt-1.5">
										<span class="text-amber-300/80">command:</span>
										<code class="ml-1 rounded bg-black/30 px-1.5 py-0.5 text-amber-100 break-all">{server.command}</code>
									</div>
									{#if server.args?.length}
										<div class="mt-1">
											<span class="text-amber-300/80">args:</span>
											<code class="ml-1 rounded bg-black/30 px-1.5 py-0.5 text-amber-100 break-all">{server.args.join(" ")}</code>
										</div>
									{/if}
								{:else}
									<div class="mt-1.5">
										<span class="text-amber-300/80">url:</span>
										<code class="ml-1 rounded bg-black/30 px-1.5 py-0.5 text-amber-100 break-all">{server.url}</code>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if perms.shell}
				<div class="mt-4 rounded-md border border-red-800 bg-red-900/30 p-3">
					<label class="flex items-start gap-2 text-sm text-red-200">
						<input
							type="checkbox"
							bind:checked={reviewSelection.shell}
							class="mt-0.5"
						/>
						<span>
							<span class="font-semibold">Shell access</span>
							<span class="mt-0.5 block text-xs text-red-300">
								Grants the extension permission to execute arbitrary shell commands. Enable only if you fully trust the author.
							</span>
						</span>
					</label>
				</div>
			{/if}

			{#if perms.network?.length}
				<div class="mt-4">
					<h4 class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">Network</h4>
					<div class="mt-2 space-y-1.5">
						{#each perms.network as domain}
							<label class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
								<input
									type="checkbox"
									checked={reviewSelection.network[domain] ?? false}
									onchange={(e) => (reviewSelection.network[domain] = (e.currentTarget as HTMLInputElement).checked)}
								/>
								<code class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs">{domain}</code>
							</label>
						{/each}
					</div>
				</div>
			{/if}

			{#if perms.filesystem?.length}
				<div class="mt-4">
					<h4 class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">Filesystem</h4>
					<div class="mt-2 space-y-1.5">
						{#each perms.filesystem as path}
							<label class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
								<input
									type="checkbox"
									checked={reviewSelection.filesystem[path] ?? false}
									onchange={(e) => (reviewSelection.filesystem[path] = (e.currentTarget as HTMLInputElement).checked)}
								/>
								<code class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs">{path}</code>
							</label>
						{/each}
					</div>
				</div>
			{/if}

			{#if perms.env?.length}
				<div class="mt-4">
					<h4 class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">Environment variables</h4>
					<div class="mt-2 space-y-1.5">
						{#each perms.env as envVar}
							<label class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
								<input
									type="checkbox"
									checked={reviewSelection.env[envVar] ?? false}
									onchange={(e) => (reviewSelection.env[envVar] = (e.currentTarget as HTMLInputElement).checked)}
								/>
								<code class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs">{envVar}</code>
							</label>
						{/each}
					</div>
				</div>
			{/if}

			{#if perms.storage}
				<div class="mt-4">
					<label class="flex items-start gap-2 text-sm text-[var(--color-text-primary)]">
						<input
							type="checkbox"
							bind:checked={reviewSelection.storage}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Persistent storage</span>
							<span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">
								Allows the extension to write key/value data that survives restarts.
							</span>
						</span>
					</label>
				</div>
			{/if}

			<!-- ── Capability tier (Phase 2+) ── -->
			{#if perms.agentConfig === "read"}
				<div class="mt-4">
					<label class="flex items-start gap-2 text-sm text-[var(--color-text-primary)]">
						<input
							type="checkbox"
							bind:checked={reviewSelection.agentConfig}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Agent config (read)</span>
							<span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">
								Lets the extension list and resolve your agent configs by name or id. Read-only — the extension cannot modify agents.
							</span>
						</span>
					</label>
				</div>
			{/if}

			{#if perms.taskEvents}
				<div class="mt-4 rounded-md border border-yellow-800/60 bg-yellow-900/20 p-3">
					<label class="flex items-start gap-2 text-sm text-yellow-100">
						<input
							type="checkbox"
							bind:checked={reviewSelection.taskEvents}
							class="mt-0.5"
						/>
						<span>
							<span class="font-semibold">Emit task panel events</span>
							<span class="mt-0.5 block text-xs text-yellow-200/80">
								Allows the extension to push task-panel updates for this conversation. Scoped to the current conversation only — the extension cannot post events to other users.
							</span>
						</span>
					</label>
				</div>
			{/if}

			{#if perms.spawnAgents}
				{@const sa = perms.spawnAgents}
				<div class="mt-4 rounded-md border border-red-800 bg-red-900/30 p-3">
					<label class="flex items-start gap-2 text-sm text-red-100">
						<input
							type="checkbox"
							bind:checked={reviewSelection.spawnAgents}
							class="mt-0.5"
						/>
						<span>
							<span class="font-semibold">Spawn AI agents (billed to your account)</span>
							<span class="mt-0.5 block text-xs text-red-200 font-medium">
								This extension will spawn AI agents billed to your account. Up to {sa.maxPerHour} runs per hour, {sa.maxConcurrent ?? 3} concurrent.
							</span>
							<span class="mt-1.5 block text-xs text-red-300/80">
								Sub-agents inherit this conversation's provider credentials. Uncheck to deny — the extension's task-assignment features will fail gracefully.
							</span>
						</span>
					</label>
				</div>
			{/if}

			{#if perms.lifecycleHooks && ext.manifest.lifecycleHooks?.length}
				<div class="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
					<h4 class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">Lifecycle hooks</h4>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">
						This extension subscribes to the following runtime events:
					</p>
					<ul class="mt-1.5 flex flex-wrap gap-1.5">
						{#each ext.manifest.lifecycleHooks as hook}
							<li>
								<code class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs">{hook}</code>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if !anyPerms && !(ext.manifest.kind === "mcp" && ext.manifest.mcpServers?.length)}
				<p class="mt-4 rounded-md bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text-secondary)]">
					This extension declares no permissions.
				</p>
			{/if}

			<div class="mt-6 flex justify-end gap-2">
				<button
					onclick={cancelReview}
					disabled={activating}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={confirmActivate}
					disabled={activating}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
				>
					{activating ? "Enabling..." : "Enable with selected permissions"}
				</button>
			</div>
		</div>
	</div>
{/if}
