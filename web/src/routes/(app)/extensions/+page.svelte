<script lang="ts">
	import { onMount, onDestroy, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { extensionReviewLocation } from "$lib/api";
	import { addToast } from "$lib/toast.svelte.js";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import UninstallDialog from "$lib/components/extensions/UninstallDialog.svelte";
	import {
		ACTIVE_TAB_STORAGE_KEY,
		type LibraryTab,
		readActiveTab,
		writeActiveTab,
	} from "$lib/extensions/library-tabs";
	import {
		DEFAULT_SORT_MODE,
		SORT_OPTIONS,
		sortExtensions,
		type ExtensionSortMode,
	} from "$lib/extensions/extension-sort";

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
		createdAt?: string | Date;
		updatedAt?: string | Date;
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
				// W2 — trigger grants for workflows the extension itself ships.
				// C3 — `allowDelegated` is the SEPARATE ask to run workflows the
				// consenting USER owns, on their behalf. It ships no workflows,
				// so it arrives with an empty `names`. Mirrors
				// `src/extensions/types.ts:634`; while this type omitted it the
				// consent UI could not see the ask at all.
				workflows?: { names: string[]; maxRunsPerHour?: number; allowDelegated?: boolean };
			};
			lifecycleHooks?: string[];
			// Extension Pages Hub — declared Hub tabs (declaring IS the grant).
			pages?: Array<{ id: string; title: string; icon?: string; description?: string }>;
		};
		grantedPermissions: Record<string, unknown>;
		isBundled?: boolean;
		/** Derived server-side from the bundled catalog's `critical: true`
		 *  (see `$lib/server/extensions/list-flags`). Drives the extra
		 *  confirm step on disable — the browser must not hardcode which
		 *  built-ins are loop-safety primitives. */
		isCritical?: boolean;
		/** Sent only for critical rows — the sentence shown before the user
		 *  turns one off. Server-supplied so it stays byte-equal to the one
		 *  the startup invariant logs (`src/extensions/critical-consequence.ts`). */
		criticalConsequence?: string;
	}

	// SSR-loaded so the first paint already shows cards. `loadExtensions()`
	// re-fetches via the existing `/api/extensions` endpoint after any
	// mutation, replacing both lists from a single response keyed by
	// `isBundled`.
	let extensions = $state<ExtensionRecord[]>(untrack(() => [
		...data.bundledExtensions,
		...data.installedExtensions,
	]));
	let loading = $state(false);
	let errorMsg = $state("");
	// Library tab state — persisted to localStorage via library-tabs helper.
	// Default "installed" preserves prior behavior for users with no
	// built-ins (Phase 53 ships them).
	let activeTab = $state<LibraryTab>("installed");
	// Sort mode for the active-tab card list. Pure client-side ordering over
	// the already-loaded list (see `extension-sort.ts`). Defaults to A–Z and
	// holds across tab switches within a session; resets to A–Z on reload
	// (not persisted — tab choice persistence is unchanged).
	let sortMode = $state<ExtensionSortMode>(DEFAULT_SORT_MODE);
	// Filtered views over `extensions` — both tabs share the install form
	// and the auto-disabled banner, but show only the cards belonging to
	// the active tab.
	let bundledExtensions = $derived(extensions.filter((e) => e.isBundled === true));
	let installedExtensions = $derived(extensions.filter((e) => e.isBundled !== true));
	// MCP extensions are surfaced as their own filter tab (kind === "mcp"),
	// matching the "MCP · {transport}" badge condition. They also still appear
	// under Installed/Built-ins per their isBundled flag — the MCP tab is a
	// focused view, not an exclusive bucket.
	let mcpExtensions = $derived(extensions.filter((e) => e.manifest?.kind === "mcp"));
	let visibleExtensions = $derived(
		sortExtensions(
			activeTab === "builtins"
				? bundledExtensions
				: activeTab === "mcp"
					? mcpExtensions
					: installedExtensions,
			sortMode,
		),
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
	// Guided-install confirmation: after a successful MCP connect+install the
	// POST returns the created extension; we surface "Connected · N tools
	// found" inline (reading manifest.tools.length) instead of silently
	// appending the card.
	let mcpInstallResult = $state<{ name: string; openUrl: string } | null>(null);

	// Uninstall confirmation — a real dialog, because the delete now reaches
	// the filesystem and the user has to answer the stored-data question.
	let uninstallTarget = $state<ExtensionRecord | null>(null);
	let uninstalling = $state(false);

	// Disabling a `critical` built-in (ask-user, task-tracking) is allowed —
	// a user may run their own replacement — but not silent: without one,
	// agents stop being able to ask questions and the symptom (a looping
	// agent) never points back here.
	let disableTarget = $state<ExtensionRecord | null>(null);
	// Locks the confirm button while the PATCH is in flight. Without it the
	// button is double-clickable into two disables — harmless server-side,
	// but the second one races `loadExtensions()` and can leave the card
	// showing the pre-disable state. `UninstallDialog` has the same guard.
	let disabling = $state(false);

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

	// agent-install-ux-polish Phase 2 (D3/D4): an agent install
	// happening while this tab is open emits a user-scoped
	// `extensions:installed` bus event; `stores.svelte.ts` re-dispatches
	// it as a window CustomEvent. Re-run the EXISTING cache-bypassing
	// `loadExtensions()` (already `fetch(..., {cache:"no-store"})`, so
	// the 60s-cached list is sidestepped — D4) so the new extension
	// appears without a manual reload. The server-side SSE filter
	// guarantees this only fires for the installing user's session, so
	// no client-side userId re-check is needed. Best-effort (D6): a
	// missing/late event simply degrades to today's manual reload.
	function handleExtensionInstalled() {
		void loadExtensions();
	}

	onMount(() => {
		// Restore the persisted tab BEFORE the first fetch so the SSR rows
		// render in the correct tab on first paint when the user has it
		// pinned to "builtins". `readActiveTab` handles SSR-safety + bad
		// JSON; default is "installed".
		activeTab = readActiveTab();
		void loadExtensions();
		if (typeof window !== "undefined") {
			window.addEventListener("extensions:installed", handleExtensionInstalled);
		}
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("extensions:installed", handleExtensionInstalled);
		}
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
		mcpInstallResult = null;
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
			const openUrl = extensionReviewLocation(await res.json());
      mcpInstallResult = { name: mcpName.trim(), openUrl };
			mcpName = "";
			mcpDescription = "";
			mcpCommand = "";
			mcpArgs = "";
			mcpUrl = "";
			mcpHeaders = "";
			addToast({ type: "info", message: "Build pending; human approval is required." });
      await goto(openUrl);
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
			const openUrl = extensionReviewLocation(await res.json());
      addToast({ type: "info", message: "Refresh staged. The active release is unchanged." });
      await goto(openUrl);
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Refresh failed" });
		}
	}

	async function toggleEnabled(ext: ExtensionRecord) {
		if (!ext.enabled) {
			openReview(ext);
			return;
		}
		// One extra beat for the loop-safety built-ins; everything else
		// disables straight away.
		if (ext.isCritical) {
			disableTarget = ext;
			return;
		}
		await disableExtension(ext);
	}

	async function disableExtension(ext: ExtensionRecord) {
		if (disabling) return;
		disabling = true;
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
			disableTarget = null;
			await loadExtensions();
			// A disabled extension's Hub tabs are gone server-side the moment
			// this lands; tell the sidebar so it stops offering links that
			// now 404.
			announceExtensionsChanged();
		} catch (e) {
			// `disableTarget` deliberately stays set on failure: the dialog
			// remains open so the user can retry, rather than closing over an
			// extension that is still enabled.
			addToast({ type: "error", message: e instanceof Error ? e.message : "Update failed" });
		} finally {
			disabling = false;
		}
	}

	/**
	 * Tell the rest of the app that the enabled set moved.
	 *
	 * The Hub nav and the Hub tab bar cache `/api/hub/pages`, which is
	 * filtered by `enabled` server-side — without this they keep showing a
	 * disabled extension's tab until a full page reload. A window
	 * CustomEvent rather than a store because the listeners live in
	 * components this page never renders; same pattern as the existing
	 * `extensions:installed` re-dispatch in `stores.svelte.ts`.
	 */
	function announceExtensionsChanged() {
		if (typeof window === "undefined") return;
		window.dispatchEvent(new CustomEvent("extensions:changed"));
	}

	async function openReview(ext: ExtensionRecord) {
		await goto(`/extensions/author?installation=${encodeURIComponent(ext.id)}`);
	}

	async function uninstall() {
		const ext = uninstallTarget;
		if (!ext) return;
		uninstalling = true;
		try {
			const res = await fetch(`/api/extensions/${ext.id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 204) {
				throw new Error(await extractError(res, "Failed to uninstall"));
			}
			uninstallTarget = null;
			addToast({
				type: "success",
				message: `${ext.name} uninstalled — its data was kept`,
			});
			await loadExtensions();
			announceExtensionsChanged();
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Uninstall failed" });
		} finally {
			uninstalling = false;
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
		<div class="flex items-center gap-3">
			<a href="/extensions/import-source" class="text-sm text-blue-400 hover:text-blue-300 transition-colors">Import source</a>
			<a
				href="/import"
				class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
				data-testid="extensions-import-link"
			>
				Import skills…
			</a>
			<a
				href="https://github.com/ezcorp-org/ezcorp/blob/main/docs/extensions/getting-started.md"
				target="_blank"
				rel="noopener noreferrer"
				class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
			>
				Create your own &rarr;
			</a>
		</div>
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
		<!-- The BACKGROUND is dark-theme-only too: `bg-red-900/40` over the light
		     surface composites to a mid-tone (#a7999e) that fights both light and
		     dark text — darker text alone tops out at 3.6:1. So the light theme
		     gets its own pair (11.8:1); dark keeps exactly what it had. -->
		<div class="rounded-lg bg-red-300/40 px-4 py-2 text-sm text-red-900 dark:bg-red-900/40 dark:text-red-400">{errorMsg}</div>
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
					<!-- 64 = the server's own ceiling (`EXTENSION_NAME_REGEX` in
					     api/mcp-servers/schema.ts, byte-identical to manifest.ts's
					     NAME_REGEX). Stopping the product from minting a name it
					     cannot render beats truncating it after the fact; the API
					     still rejects an over-long name, this just says so earlier. -->
					<input
						type="text"
						bind:value={mcpName}
						maxlength={64}
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
						autocomplete="off"
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
				{#if mcpInstallResult}
					<!-- Same dark-theme-only pairing as the error banner above:
					     `text-green-200` on `bg-green-900/30` washes out over the light
					     surface. Light gets its own pair (11.6:1); dark is unchanged. -->
					<div
						class="flex items-center justify-between rounded-md border border-green-800 bg-green-300/40 px-3 py-2 text-sm text-green-900 dark:bg-green-900/30 dark:text-green-200"
						data-testid="mcp-install-confirmation"
					>
						<span>
							<span class="font-medium">Build pending</span> ·
              {mcpInstallResult.name} needs human approval.
              <a class="underline" href={mcpInstallResult.openUrl}>Review the tested release</a>
						</span>
						<button
							onclick={() => (mcpInstallResult = null)}
							aria-label="Dismiss confirmation"
							class="ml-2 rounded p-0.5 text-green-300/80 hover:text-green-100"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Library tabs (Phase 52.1) — split Built-ins (`isBundled=true`)
	     from user-Installed extensions. Active tab persists to
	     localStorage via `writeActiveTab`. -->
	<div class="border-b border-[var(--color-border)]">
		<div class="flex items-end justify-between gap-3">
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
			<button
				role="tab"
				aria-selected={activeTab === "mcp"}
				aria-controls="ext-tab-panel"
				data-testid="ext-tab-mcp"
				onclick={() => selectTab("mcp")}
				class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'mcp' ? 'border-blue-500 text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				MCP <span class="ml-1 text-xs text-[var(--color-text-muted)]">{mcpExtensions.length}</span>
			</button>
		</div>
		<!-- Sort control — pure client-side reorder of the active-tab cards.
		     Styled to match the Marketplace select. -->
		<div class="flex items-center gap-2 pb-2">
			<label for="ext-sort-select" class="text-xs text-[var(--color-text-muted)]">Sort:</label>
			<select
				id="ext-sort-select"
				data-testid="ext-sort-select"
				bind:value={sortMode}
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-secondary)] focus:border-[var(--color-accent)] focus:outline-none"
			>
				{#each SORT_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</div>
		</div>
	</div>

	<!-- Extensions List -->
	<div id="ext-tab-panel" role="tabpanel" data-testid="ext-tab-panel" data-active-tab={activeTab}>
	{#if loading}
		<SkeletonLoader type="card-grid" count={6} />
	{:else if visibleExtensions.length === 0}
		{#if activeTab === "mcp"}
			<EmptyState
				title="No MCP servers connected"
				description="Connect a Model Context Protocol server above (stdio, Streamable HTTP, or SSE) to expose its tools to your agents."
			>
				{#snippet icon()}
					<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M5 12a2 2 0 01-2-2V7a2 2 0 012-2h14a2 2 0 012 2v3a2 2 0 01-2 2M5 12a2 2 0 00-2 2v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 00-2-2" />
					</svg>
				{/snippet}
			</EmptyState>
		{:else if activeTab === "builtins"}
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
				<!-- `min-w-0` on the GRID ITEM, not just the flex child inside it: a
				     grid item defaults to `min-width: auto`, so an unbreakable 64-char
				     name sets the track's min-content width and widens the whole
				     column. Measured at a 393px viewport: the card rendered 703px, the
				     page scrolled sideways, and `truncate` was inert because the
				     heading had all the room it asked for. -->
				<div
					class="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
					data-testid="ext-card"
					data-ext-id={ext.id}
				>
					<div class="mb-2 flex items-start justify-between gap-2">
						<!-- `min-w-0` on the flex child: without it the name's intrinsic
						     width wins over the row, so a long-but-legal name (the
						     install form admits 64 chars) wrapped to four lines, pushed
						     the transport badge into a 2-line blob on top of it and
						     squeezed the toggle into a circle. -->
						<a href="/extensions/{ext.id}" class="group min-w-0">
							<div class="flex items-center gap-2">
								<h3 class="truncate font-medium text-[var(--color-text-primary)] group-hover:text-blue-400" title={ext.name}>{ext.name}</h3>
								{#if ext.manifest.kind === "mcp"}
									<span class="shrink-0 whitespace-nowrap rounded-full bg-purple-900/50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-purple-200">MCP · {ext.manifest.mcpServers?.[0]?.transport ?? "?"}</span>
								{/if}
								{#if !ext.enabled}
									<span class="shrink-0 whitespace-nowrap rounded-full bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--color-text-muted)]">Disabled</span>
								{/if}
							</div>
							<p class="text-xs text-[var(--color-text-muted)]">v{ext.version}</p>
						</a>
						<button
							onclick={() => toggleEnabled(ext)}
							class="relative h-6 w-11 shrink-0 rounded-full transition-colors {ext.enabled ? 'bg-blue-600' : 'bg-[var(--color-surface-tertiary)]'}"
							title={ext.enabled ? "Disable" : "Enable"}
						>
							<span
								class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform {ext.enabled ? 'left-[22px]' : 'left-0.5'}"
							></span>
						</button>
					</div>

					<p class="mb-3 text-sm text-[var(--color-text-secondary)]">{ext.description || "No description"}</p>

					{#if !ext.enabled && ext.manifest.pages?.length}
						<!-- Name the side effect where the user caused it. The Hub tab
						     vanishes from the sidebar the moment this is switched off,
						     and nothing on the Hub itself explains why. -->
						<p
							class="mb-3 text-xs text-[var(--color-text-muted)]"
							data-testid="ext-card-pages-hidden"
						>
							{ext.manifest.pages.length === 1 ? "Its Hub tab is" : "Its Hub tabs are"} hidden
							while this is off.
						</p>
					{/if}

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
								<!-- `--color-red-400` (#ff8a85) is retinted once in `:root`
								     and never per theme, so it is tuned for dark surfaces:
								     on the light surface here it measures ~2:1, well under
								     AA's 4.5 for a DESTRUCTIVE control. Fixed locally with a
								     light-mode red rather than by retinting the token, which
								     would shift every red in the app. -->
								<button
									onclick={() => (uninstallTarget = ext)}
									class="rounded-md px-2 py-1 text-xs text-red-700 transition-colors hover:bg-red-900/30 dark:text-red-400"
									data-testid="ext-card-uninstall"
								>
									Uninstall
								</button>
							{:else}
								<!-- Built-ins ship with the harness: the row is recreated at
								     every boot, so deleting it would discard the admin's
								     permission narrowing and change nothing else. The toggle
								     beside it is the real off switch, and it now survives a
								     restart. -->
								<span
									class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-muted)]"
									title="Ships with EZCorp — turn it off with the toggle instead of uninstalling"
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

<UninstallDialog
	open={uninstallTarget !== null}
	extensionName={uninstallTarget?.name ?? ""}
	busy={uninstalling}
	onconfirm={uninstall}
	oncancel={() => (uninstallTarget = null)}
/>

{#if disableTarget}
	{@const ext = disableTarget}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onkeydown={(e) => { if (e.key === "Escape" && !disabling) disableTarget = null; }}
		onclick={(e) => { if (e.target === e.currentTarget && !disabling) disableTarget = null; }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="disable-critical-title"
		data-testid="disable-critical-dialog"
		tabindex={-1}
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<h3 id="disable-critical-title" class="text-base font-semibold text-[var(--color-text-primary)]">
				Turn off {ext.name}?
			</h3>
			<p class="mt-2 text-sm text-[var(--color-text-secondary)]" data-testid="disable-critical-consequence">
				{ext.criticalConsequence}
			</p>
			<p class="mt-2 text-sm text-[var(--color-text-secondary)]">
				That is fine if another extension provides the same tool — install yours
				first, then turn this one off.
			</p>
			<div class="mt-6 flex justify-end gap-2">
				<button
					onclick={() => (disableTarget = null)}
					disabled={disabling}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					Keep it on
				</button>
				<button
					onclick={() => disableExtension(ext)}
					disabled={disabling}
					class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
					data-testid="disable-critical-confirm"
				>
					{disabling ? "Turning it off…" : "Turn it off"}
				</button>
			</div>
		</div>
	</div>
{/if}
