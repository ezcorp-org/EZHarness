<script lang="ts">
	import { fetchSettings, upsertSetting, fetchModes, deleteMode as apiDeleteMode, type ProviderStatus, type Mode, testLocalModelConnection, type LocalModelCheckResult, listLocalModels, type LocalModelListEntry } from "$lib/api.js";
	import ModeFormModal from "$lib/components/ModeFormModal.svelte";
	import ProviderSettings from "$lib/components/ProviderSettings.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import ApiKeyManager from "$lib/components/settings/ApiKeyManager.svelte";
	import SecuritySettings from "$lib/components/settings/SecuritySettings.svelte";
	import SystemHealth from "$lib/components/settings/SystemHealth.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import MobileCardStack from "$lib/components/MobileCardStack.svelte";
	import ProviderIcon from "$lib/components/ProviderIcon.svelte";
	import { PROVIDER_META } from "$lib/provider-meta.js";

	// Current user
	type CurrentUser = { id: string; email: string; name: string; role: "admin" | "member" };
	type UserEntry = { id: string; email: string; name: string; role: string; status: string };
	type TeamEntry = { id: string; name: string; createdAt: string; role?: string };
	type TeamMemberEntry = { id: string; userId: string; userName: string; userEmail: string; role: string };
	type InviteEntry = { id: string; email: string | null; token: string; role: string; expiresAt: string; usedAt: string | null };
	type AuditLogEntry = { id: string; userId: string | null; action: string; target: string | null; metadata: Record<string, unknown> | null; createdAt: string };

	let currentUser = $state<CurrentUser | null>(null);
	let pageLoading = $state(true);

	// Settings state
	let defaultTier = $state<string>("balanced");
	let preferenceOrder = $state<string[]>(["anthropic", "openai", "google"]);
	let customModels = $state<{ modelId: string; provider: string; tier: string; baseUrl?: string }[]>([]);
	let globalPrompt = $state("");
	let showObservability = $state(false);
	let agentAutonomyEnabled = $state(true);
	// Phase 52.5 — Audit & Visibility settings.
	let showBuiltinPills = $state(true);
	let showInstalledPills = $state(false);
	let eventAuditSampleN = $state(100);
	let auditSectionOpen = $state(false);
	let savingPills = $state(false);

	// Modes
	let allModes = $state<Mode[]>([]);
	let editingMode = $state<Mode | null>(null);
	let showModeModal = $state(false);
	let modeViewMode = $state(false);

	let savingTier = $state(false);
	let savingOrder = $state(false);
	let savingCustom = $state(false);
	let savingPrompt = $state(false);
	let savingObs = $state(false);
	let savingAutonomy = $state(false);

	// Custom model form
	let newModelId = $state("");
	let newModelProvider = $state("anthropic");
	let newModelTier = $state("balanced");
	let newModelBaseUrl = $state("");
	let localTestResults = $state<Record<string, import("$lib/api.js").LocalModelCheckResult | "testing">>({});

	// Model discovery
	let discoveredModels = $state<LocalModelListEntry[]>([]);
	let discoveringModels = $state(false);
	let discoveryError = $state<string | null>(null);

	const isLocalProvider = $derived(newModelProvider === "ollama" || newModelBaseUrl.trim().length > 0);

	// Ollama provider state
	let ollamaUrl = $state("http://localhost:11434");
	let ollamaModels = $state<LocalModelListEntry[]>([]);
	let ollamaFetching = $state(false);
	let ollamaError = $state<string | null>(null);
	let ollamaAddingModel = $state<string | null>(null);
	let ollamaTestResults = $state<Record<string, import("$lib/api.js").LocalModelCheckResult | "testing">>({});
	let savingOllamaUrl = $state(false);

	const ollamaCustomModels = $derived(customModels.filter((m) => m.provider === "ollama"));
	const ollamaConnected = $derived(ollamaCustomModels.length > 0);

	// Admin: Users
	let allUsers = $state<UserEntry[]>([]);
	let loadingUsers = $state(false);

	// Admin: Teams
	let allTeams = $state<TeamEntry[]>([]);
	let loadingTeams = $state(false);
	let newTeamName = $state("");
	let expandedTeamId = $state<string | null>(null);
	let teamMembers = $state<Record<string, TeamMemberEntry[]>>({});
	let addMemberUserId = $state("");
	let addMemberRole = $state<"viewer" | "editor" | "owner">("viewer");

	// Admin: Invites
	let allInvites = $state<InviteEntry[]>([]);
	let loadingInvites = $state(false);
	let inviteEmail = $state("");
	let inviteRole = $state<"admin" | "member">("member");
	let copiedInviteId = $state<string | null>(null);

	// Admin: Password reset
	let copiedResetUserId = $state<string | null>(null);

	// Admin: Sessions
	type AdminSessionEntry = { id: string; userId: string; userName: string | null; userEmail: string | null; userAgent: string | null; ipAddress: string | null; lastActiveAt: string | null; createdAt: string };
	let adminSessions = $state<AdminSessionEntry[]>([]);
	let sessionCountByUser = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const s of adminSessions) {
			counts[s.userId] = (counts[s.userId] ?? 0) + 1;
		}
		return counts;
	});
	let forceLogoutUserId = $state<string | null>(null);
	let confirmForceLogout = $state<string | null>(null);
	let forceLogoutMessage = $state<{ type: "success" | "error"; text: string } | null>(null);

	// Admin: Audit Log
	let auditEntries = $state<AuditLogEntry[]>([]);
	let loadingAudit = $state(false);
	let auditOffset = $state(0);
	let auditFilter = $state<string>("");
	let hasMoreAudit = $state(false);

	// MobileCardStack data for audit log
	let auditRows = $derived(
		auditEntries.map((e) => ({
			id: e.id,
			time: new Date(e.createdAt).toLocaleString(),
			action: e.action,
			target: e.target ?? "-",
			details: e.metadata ? JSON.stringify(e.metadata) : "-",
		}))
	);
	const auditColumns = [
		{ key: "time", label: "Time" },
		{ key: "action", label: "Action" },
		{ key: "target", label: "Target" },
		{ key: "details", label: "Details" },
	];

	const TIERS = ["fast", "balanced", "powerful"] as const;
	const PROVIDERS = ["anthropic", "openai", "google", "ollama"] as const;

	async function loadCurrentUser() {
		try {
			const res = await fetch("/api/auth/me");
			if (res.ok) {
				const data = await res.json();
				currentUser = data.user;
			}
		} catch { /* silent */ }
	}

	async function loadSettings() {
		try {
			const settings = await fetchSettings();
			defaultTier = (settings["provider:defaultTier"] as string) ?? "balanced";
			preferenceOrder = (settings["provider:preferenceOrder"] as string[]) ?? ["anthropic", "openai", "google"];
			customModels = (settings["provider:customModels"] as typeof customModels) ?? [];
			ollamaUrl = (settings["provider:ollamaUrl"] as string) ?? "http://localhost:11434";
			globalPrompt = (settings["global:systemPrompt"] as string) ?? "";
			showObservability = (settings["global:showObservability"] as boolean) ?? false;
			agentAutonomyEnabled = settings["global:agentAutonomyEnabled"] !== false;
			// Phase 52.5 — audit & visibility section. Defaults
			// match the spec: built-in pills ON, installed pills OFF,
			// event-delivery audit sample 1-in-100.
			showBuiltinPills = settings["global:showBuiltinCapabilityEvents"] !== false;
			showInstalledPills = settings["global:showInstalledCapabilityEvents"] === true;
			const sampleN = settings["global:eventSubscriptionAuditSampleN"];
			eventAuditSampleN = typeof sampleN === "number" && sampleN >= 1 && sampleN <= 10000
				? Math.floor(sampleN)
				: 100;
		} catch { /* silent */ }
	}

	async function loadUsers() {
		loadingUsers = true;
		try {
			const res = await fetch("/api/users");
			if (res.ok) {
				const data = await res.json();
				allUsers = data.users;
			}
		} catch { /* silent */ }
		loadingUsers = false;
	}

	async function loadTeams() {
		loadingTeams = true;
		try {
			const res = await fetch("/api/teams");
			if (res.ok) {
				const data = await res.json();
				allTeams = data.teams;
			}
		} catch { /* silent */ }
		loadingTeams = false;
	}

	async function loadInvites() {
		loadingInvites = true;
		try {
			const res = await fetch("/api/auth/invite");
			if (res.ok) {
				const data = await res.json();
				allInvites = data.invites;
			}
		} catch { /* silent */ }
		loadingInvites = false;
	}

	async function loadAuditLog(reset = false) {
		if (reset) {
			auditOffset = 0;
			auditEntries = [];
		}
		loadingAudit = true;
		try {
			const params = new URLSearchParams({ limit: "50", offset: String(auditOffset) });
			if (auditFilter) params.set("action", auditFilter);
			const res = await fetch(`/api/audit-log?${params}`);
			if (res.ok) {
				const data = await res.json();
				if (reset) {
					auditEntries = data.entries;
				} else {
					auditEntries = [...auditEntries, ...data.entries];
				}
				hasMoreAudit = data.entries.length === 50;
				auditOffset += data.entries.length;
			}
		} catch { /* silent */ }
		loadingAudit = false;
	}

	async function loadAdminSessions() {
		try {
			const res = await fetch("/api/admin/sessions");
			if (res.ok) {
				const data = await res.json();
				adminSessions = data.sessions;
			}
		} catch { /* silent */ }
	}

	async function forceLogout(userId: string) {
		forceLogoutUserId = userId;
		forceLogoutMessage = null;
		try {
			const res = await fetch("/api/admin/sessions", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId }),
			});
			if (res.ok) {
				const data = await res.json();
				adminSessions = adminSessions.filter((s) => s.userId !== userId);
				forceLogoutMessage = { type: "success", text: `Revoked ${data.revokedCount} session(s).` };
			} else {
				const data = await res.json();
				forceLogoutMessage = { type: "error", text: data.error || "Failed to force logout." };
			}
		} catch {
			forceLogoutMessage = { type: "error", text: "Network error." };
		} finally {
			forceLogoutUserId = null;
			confirmForceLogout = null;
		}
	}

	$effect(() => {
		loadCurrentUser().then(async () => {
			const loads: Promise<void>[] = [loadSettings(), loadModesList()];
			if (currentUser?.role === "admin") {
				loads.push(loadUsers(), loadTeams(), loadInvites(), loadAuditLog(true), loadAdminSessions());
			}
			await Promise.all(loads);
			pageLoading = false;
			// Scroll to hash target after ALL content has loaded and rendered
			if (window.location.hash) {
				setTimeout(() => {
					document.querySelector(window.location.hash)?.scrollIntoView({ behavior: "smooth" });
				}, 100);
			}
		});
	});

	// Modes functions
	async function loadModesList() {
		try { allModes = await fetchModes(); } catch { /* non-fatal */ }
	}

	function openCreateMode() {
		editingMode = null;
		modeViewMode = false;
		showModeModal = true;
	}

	function openViewMode(mode: Mode) {
		editingMode = mode;
		modeViewMode = true;
		showModeModal = true;
	}

	async function handleModeSaved() {
		showModeModal = false;
		editingMode = null;
		modeViewMode = false;
		await loadModesList();
	}

	async function handleDeleteMode(id: string) {
		if (!confirm("Delete this custom mode?")) return;
		try {
			await apiDeleteMode(id);
			await loadModesList();
		} catch (e: any) {
			alert(e.message || "Failed to delete mode");
		}
	}

	// Settings save functions
	async function saveTier() {
		savingTier = true;
		try { await upsertSetting("provider:defaultTier", defaultTier); }
		finally { savingTier = false; }
	}

	async function saveOrder() {
		savingOrder = true;
		try { await upsertSetting("provider:preferenceOrder", preferenceOrder); }
		finally { savingOrder = false; }
	}

	function moveProvider(index: number, direction: -1 | 1) {
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= preferenceOrder.length) return;
		const copy = [...preferenceOrder];
		[copy[index], copy[newIndex]] = [copy[newIndex]!, copy[index]!];
		preferenceOrder = copy;
	}

	async function saveOllamaUrl() {
		savingOllamaUrl = true;
		try { await upsertSetting("provider:ollamaUrl", ollamaUrl); }
		finally { savingOllamaUrl = false; }
	}

	async function fetchOllamaModels() {
		const url = ollamaUrl.trim();
		if (!url) return;
		ollamaFetching = true;
		ollamaError = null;
		ollamaModels = [];
		try {
			const result = await listLocalModels(url);
			if (result.error) {
				ollamaError = result.error;
			} else if (result.models.length === 0) {
				ollamaError = "No models found — pull a model with: ollama pull <model>";
			} else {
				ollamaModels = result.models;
			}
		} catch {
			ollamaError = "Failed to connect to Ollama";
		} finally {
			ollamaFetching = false;
		}
	}

	async function addOllamaModel(modelId: string) {
		if (customModels.some((m) => m.modelId === modelId && m.provider === "ollama")) return;
		ollamaAddingModel = modelId;
		const entry = { modelId, provider: "ollama", tier: "balanced" as string, baseUrl: ollamaUrl.trim() };
		customModels = [...customModels, entry];
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; ollamaAddingModel = null; }
	}

	async function removeOllamaModel(modelId: string) {
		customModels = customModels.filter((m) => !(m.modelId === modelId && m.provider === "ollama"));
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}

	async function handleTestOllamaModel(modelId: string) {
		ollamaTestResults = { ...ollamaTestResults, [modelId]: "testing" };
		try {
			const result = await testLocalModelConnection(ollamaUrl.trim(), modelId);
			ollamaTestResults = { ...ollamaTestResults, [modelId]: result };
		} catch {
			ollamaTestResults = { ...ollamaTestResults, [modelId]: {
				reachable: false, modelAvailable: null, inferenceOk: null,
				endpointType: null, error: "Connection failed"
			}};
		}
	}

	async function discoverModels() {
		const url = newModelBaseUrl.trim();
		if (!url) return;
		discoveringModels = true;
		discoveryError = null;
		discoveredModels = [];
		newModelId = "";
		try {
			const result = await listLocalModels(url);
			if (result.error) {
				discoveryError = result.error;
			} else if (result.models.length === 0) {
				discoveryError = "No models found on this endpoint";
			} else {
				discoveredModels = result.models;
				newModelId = result.models[0]!.id;
			}
		} catch {
			discoveryError = "Failed to connect to endpoint";
		} finally {
			discoveringModels = false;
		}
	}

	async function addCustomModel() {
		const id = newModelId.trim();
		if (!id) return;
		if (customModels.some((m) => m.modelId === id)) return;
		const entry: { modelId: string; provider: string; tier: string; baseUrl?: string } = { modelId: id, provider: newModelProvider, tier: newModelTier };
		const url = newModelBaseUrl.trim();
		if (url) entry.baseUrl = url;
		customModels = [...customModels, entry];
		newModelId = "";
		newModelBaseUrl = "";
		discoveredModels = [];
		discoveryError = null;
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}

	async function handleTestLocalModel(modelId: string, baseUrl: string) {
		localTestResults = { ...localTestResults, [modelId]: "testing" };
		try {
			const result = await testLocalModelConnection(baseUrl, modelId);
			localTestResults = { ...localTestResults, [modelId]: result };
		} catch {
			localTestResults = { ...localTestResults, [modelId]: {
				reachable: false, modelAvailable: null, inferenceOk: null,
				endpointType: null, error: "Connection failed"
			}};
		}
	}

	async function removeCustomModel(modelId: string) {
		customModels = customModels.filter((m) => m.modelId !== modelId);
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}

	async function saveGlobalPrompt() {
		savingPrompt = true;
		try { await upsertSetting("global:systemPrompt", globalPrompt); }
		finally { savingPrompt = false; }
	}

	async function toggleObservability() {
		savingObs = true;
		showObservability = !showObservability;
		try { await upsertSetting("global:showObservability", showObservability); }
		finally { savingObs = false; }
	}

	async function toggleAgentAutonomy() {
		savingAutonomy = true;
		agentAutonomyEnabled = !agentAutonomyEnabled;
		try { await upsertSetting("global:agentAutonomyEnabled", agentAutonomyEnabled); }
		finally { savingAutonomy = false; }
	}

	// Phase 52.5 — Audit & Visibility persistence. Same upsertSetting
	// flow as the existing observability toggle (one round-trip per
	// change; no debounce — settings are admin-only writes anyway).
	async function toggleBuiltinPills() {
		savingPills = true;
		showBuiltinPills = !showBuiltinPills;
		try { await upsertSetting("global:showBuiltinCapabilityEvents", showBuiltinPills); }
		finally { savingPills = false; }
	}
	async function toggleInstalledPills() {
		savingPills = true;
		showInstalledPills = !showInstalledPills;
		try { await upsertSetting("global:showInstalledCapabilityEvents", showInstalledPills); }
		finally { savingPills = false; }
	}
	async function saveEventAuditSampleN(): Promise<void> {
		// Clamp to [1, 10000] — same range the dispatcher enforces
		// server-side in Phase 51.4. Defends against typos like 0
		// (would mean "audit every event" — explicit ON has its own
		// keyword) or negative values.
		const clamped = Math.max(1, Math.min(10000, Math.floor(eventAuditSampleN)));
		eventAuditSampleN = clamped;
		savingPills = true;
		try { await upsertSetting("global:eventSubscriptionAuditSampleN", clamped); }
		finally { savingPills = false; }
	}

	// Admin: User management
	async function deactivateUser(userId: string) {
		const res = await fetch(`/api/users/${userId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "inactive" }),
		});
		if (res.ok) await loadUsers();
	}

	async function reactivateUser(userId: string) {
		const res = await fetch(`/api/users/${userId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "active" }),
		});
		if (res.ok) await loadUsers();
	}

	// Admin: Team management
	async function createTeam() {
		if (!newTeamName.trim()) return;
		const res = await fetch("/api/teams", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: newTeamName.trim() }),
		});
		if (res.ok) {
			newTeamName = "";
			await loadTeams();
		}
	}

	async function deleteTeam(teamId: string) {
		const res = await fetch(`/api/teams/${teamId}`, { method: "DELETE" });
		if (res.ok) {
			if (expandedTeamId === teamId) expandedTeamId = null;
			await loadTeams();
		}
	}

	async function toggleTeamExpand(teamId: string) {
		if (expandedTeamId === teamId) {
			expandedTeamId = null;
			return;
		}
		expandedTeamId = teamId;
		const res = await fetch(`/api/teams/${teamId}/members`);
		if (res.ok) {
			const data = await res.json();
			teamMembers = { ...teamMembers, [teamId]: data.members };
		}
	}

	async function addMemberToTeam(teamId: string) {
		if (!addMemberUserId) return;
		const res = await fetch(`/api/teams/${teamId}/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: addMemberUserId, role: addMemberRole }),
		});
		if (res.ok) {
			addMemberUserId = "";
			addMemberRole = "viewer";
			await toggleTeamExpand(teamId);
			expandedTeamId = teamId;
		}
	}

	async function removeMemberFromTeam(teamId: string, userId: string) {
		const res = await fetch(`/api/teams/${teamId}/members`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId }),
		});
		if (res.ok) {
			await toggleTeamExpand(teamId);
			expandedTeamId = teamId;
		}
	}

	// Admin: Invite management
	async function createInvite() {
		const res = await fetch("/api/auth/invite", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: inviteEmail || undefined, role: inviteRole }),
		});
		if (res.ok) {
			inviteEmail = "";
			inviteRole = "member";
			await loadInvites();
		}
	}

	async function deleteInvite(inviteId: string) {
		const res = await fetch(`/api/auth/invite/${inviteId}`, { method: "DELETE" });
		if (res.ok) await loadInvites();
	}

	async function resetUserPassword(userId: string) {
		try {
			const res = await fetch("/api/auth/reset-password", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId }),
			});
			if (!res.ok) return;
			const data = await res.json();
			const url = `${window.location.origin}${data.resetUrl}`;
			await navigator.clipboard.writeText(url);
			copiedResetUserId = userId;
			setTimeout(() => { copiedResetUserId = null; }, 2000);
		} catch { /* silent */ }
	}

	function copyInviteLink(invite: InviteEntry) {
		const url = `${window.location.origin}/api/auth/invite/${invite.token}`;
		navigator.clipboard.writeText(url);
		copiedInviteId = invite.id;
		setTimeout(() => { copiedInviteId = null; }, 2000);
	}


	// Provider accordion state
	let providersExpanded = $state(true);
	let providerStatuses = $state<ProviderStatus[]>([]);

	function getStatusDotColor(p: ProviderStatus): string {
		if (!p.hasKey && !p.oauthConnected) return "bg-gray-500";
		if (p.oauthExpired) return "bg-amber-500";
		return "bg-green-500";
	}
</script>

<div class="mx-auto max-w-3xl space-y-6">
	<h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>

	{#if pageLoading}
		<SkeletonLoader type="form" />
	{:else}
	<!-- Admin: Users -->
	{#if currentUser?.role === "admin"}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">Users</h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Manage user accounts. Deactivating a user transfers their agents to you.</p>
			{#if forceLogoutMessage}
				<p class="mb-3 text-xs {forceLogoutMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}">{forceLogoutMessage.text}</p>
			{/if}
			{#if loadingUsers}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
			{:else if allUsers.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">No users found.</p>
			{:else}
				<div class="max-h-64 space-y-2 overflow-y-auto">
					{#each allUsers as u}
						<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
							<div class="flex flex-wrap items-center gap-2 md:gap-3">
								<div class="flex-1 min-w-0 basis-full md:basis-auto">
									<p class="text-sm text-[var(--color-text-primary)] truncate">{u.name}</p>
									<p class="text-xs text-[var(--color-text-secondary)] truncate">{u.email}</p>
								</div>
								<span class="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]" title="Active sessions">{sessionCountByUser[u.id] ?? 0} sessions</span>
								<span class="text-xs px-2 py-0.5 rounded-full {u.role === 'admin' ? 'bg-purple-900 text-purple-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">{u.role}</span>
								<span class="text-xs px-2 py-0.5 rounded-full {u.status === 'active' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}">{u.status}</span>
								{#if u.id !== currentUser?.id}
									<button onclick={() => resetUserPassword(u.id)} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">
										{copiedResetUserId === u.id ? "Link copied!" : "Reset Password"}
									</button>
									{#if (sessionCountByUser[u.id] ?? 0) > 0}
										{#if confirmForceLogout === u.id}
											<span class="text-xs text-yellow-400">Confirm?</span>
											<button onclick={() => forceLogout(u.id)} disabled={forceLogoutUserId === u.id} class="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">
												{forceLogoutUserId === u.id ? "Logging out..." : "Yes"}
											</button>
											<button onclick={() => { confirmForceLogout = null; }} class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">No</button>
										{:else}
											<button onclick={() => { confirmForceLogout = u.id; }} class="text-xs text-orange-400 hover:text-orange-300 transition-colors">Force Logout</button>
										{/if}
									{/if}
									{#if u.status === "active"}
										<button onclick={() => deactivateUser(u.id)} class="text-xs text-red-400 hover:text-red-300 transition-colors">Deactivate</button>
									{:else}
										<button onclick={() => reactivateUser(u.id)} class="text-xs text-green-400 hover:text-green-300 transition-colors">Reactivate</button>
									{/if}
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Admin: Teams -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">Teams</h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Create and manage teams. Agents, memories, and KB files are shared to teams.</p>

			<!-- Create team -->
			<div class="flex gap-2 mb-4">
				<input type="text" bind:value={newTeamName} placeholder="New team name" class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none" />
				<button onclick={createTeam} disabled={!newTeamName.trim()} class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">Create Team</button>
			</div>

			{#if loadingTeams}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
			{:else if allTeams.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">No teams yet.</p>
			{:else}
				<div class="space-y-2">
					{#each allTeams as team}
						<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
							<div class="flex items-center gap-3 px-4 py-2">
								<button data-testid="team-expand-{team.id}" onclick={() => toggleTeamExpand(team.id)} class="flex-1 text-left text-sm text-[var(--color-text-primary)] hover:text-blue-400 transition-colors">{team.name}</button>
								<button onclick={() => deleteTeam(team.id)} class="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
							</div>

							{#if expandedTeamId === team.id}
								<div class="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
									<h4 class="text-xs font-medium text-[var(--color-text-secondary)] uppercase">Members</h4>
									{#if teamMembers[team.id]?.length}
										<div class="space-y-1">
											{#each teamMembers[team.id]! as member}
												<div class="flex items-center gap-2 text-xs">
													<span class="flex-1 text-[var(--color-text-secondary)]">{member.userName} ({member.userEmail})</span>
													<span class="text-[var(--color-text-muted)]">{member.role}</span>
													<button onclick={() => removeMemberFromTeam(team.id, member.userId)} class="text-red-400 hover:text-red-300 transition-colors">Remove</button>
												</div>
											{/each}
										</div>
									{:else}
										<p class="text-xs text-[var(--color-text-muted)]">No members.</p>
									{/if}

									<!-- Add member form -->
									<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-end pt-2 border-t border-[var(--color-border)]">
										<div class="flex-1">
											<label for="settings-team-add-member-user" class="block text-xs text-[var(--color-text-muted)] mb-1">User</label>
											<select id="settings-team-add-member-user" bind:value={addMemberUserId} aria-label="Select user" class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
												<option value="">Select user...</option>
												{#each allUsers.filter(u => u.status === "active" && !teamMembers[team.id]?.some(m => m.userId === u.id)) as u}
													<option value={u.id}>{u.name} ({u.email})</option>
												{/each}
											</select>
										</div>
										<div>
											<label for="settings-team-add-member-role" class="block text-xs text-[var(--color-text-muted)] mb-1">Role</label>
											<select id="settings-team-add-member-role" bind:value={addMemberRole} aria-label="Member role" class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
												<option value="viewer">Viewer</option>
												<option value="editor">Editor</option>
												<option value="owner">Owner</option>
											</select>
										</div>
										<button onclick={() => addMemberToTeam(team.id)} disabled={!addMemberUserId} class="rounded-md bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">Add</button>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Admin: Invites -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">Invites</h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Create invite links for new users. Links expire after 7 days.</p>

			<!-- Create invite form -->
			<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-end mb-4">
				<div class="flex-1">
					<label for="settings-invite-email" class="block text-xs text-[var(--color-text-secondary)] mb-1">Email (optional)</label>
					<input id="settings-invite-email" type="email" bind:value={inviteEmail} placeholder="user@example.com" class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none" />
				</div>
				<div>
					<label for="invite-role" class="block text-xs text-[var(--color-text-secondary)] mb-1">Role</label>
					<select id="invite-role" bind:value={inviteRole} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
						<option value="member">Member</option>
						<option value="admin">Admin</option>
					</select>
				</div>
				<button onclick={createInvite} class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors">Create Invite</button>
			</div>

			{#if loadingInvites}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
			{:else if allInvites.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">No pending invites.</p>
			{:else}
				<div class="space-y-2">
					{#each allInvites as invite}
						<div class="flex flex-wrap items-center gap-2 md:gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
							<div class="flex-1 min-w-0 basis-full md:basis-auto">
								<p class="text-sm text-[var(--color-text-primary)] truncate">{invite.email ?? "(any email)"}</p>
								<p class="text-xs text-[var(--color-text-muted)]">Expires: {new Date(invite.expiresAt).toLocaleDateString()}</p>
							</div>
							<span class="text-xs px-2 py-0.5 rounded-full {invite.role === 'admin' ? 'bg-purple-900 text-purple-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">{invite.role}</span>
							{#if invite.usedAt}
								<span class="text-xs text-[var(--color-text-muted)]">Used</span>
							{:else}
								<button onclick={() => copyInviteLink(invite)} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">
									{copiedInviteId === invite.id ? "Copied!" : "Copy Link"}
								</button>
								<button onclick={() => deleteInvite(invite.id)} class="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Admin: Audit Log -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">Audit Log</h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">View authentication and sharing events.</p>

			<!-- Filter -->
			<div class="mb-4">
				<select
					bind:value={auditFilter}
					onchange={() => loadAuditLog(true)}
					aria-label="Filter audit events"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					<option value="">All events</option>
					<option value="auth:login">Login</option>
					<option value="auth:failed_login">Failed login</option>
					<option value="user:registered">Registration</option>
					<option value="user:invited">Invite created</option>
					<option value="user:deactivated">User deactivated</option>
					<option value="agent:shared">Agent shared</option>
					<option value="agent:unshared">Agent unshared</option>
				</select>
			</div>

			{#if loadingAudit && auditEntries.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
			{:else if auditEntries.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">No audit events found.</p>
			{:else}
				<div class="hidden md:block overflow-x-auto">
					<table class="w-full text-xs">
						<thead>
							<tr class="border-b border-[var(--color-border)] text-left text-[var(--color-text-secondary)]">
								<th class="pb-2 pr-3">Time</th>
								<th class="pb-2 pr-3">Action</th>
								<th class="pb-2 pr-3">Target</th>
								<th class="pb-2">Details</th>
							</tr>
						</thead>
						<tbody>
							{#each auditEntries as entry}
								<tr class="border-b border-[var(--color-border)]">
									<td class="py-2 pr-3 text-[var(--color-text-secondary)] whitespace-nowrap">
										{new Date(entry.createdAt).toLocaleString()}
									</td>
									<td class="py-2 pr-3">
										<span class="rounded-full px-2 py-0.5 text-xs font-medium
											{entry.action.startsWith('auth:') ? 'bg-blue-900 text-blue-300' :
											entry.action.startsWith('user:') ? 'bg-purple-900 text-purple-300' :
											entry.action.startsWith('agent:') ? 'bg-green-900 text-green-300' :
											'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">
											{entry.action}
										</span>
									</td>
									<td class="py-2 pr-3 text-[var(--color-text-secondary)] truncate max-w-[120px]">{entry.target ?? "-"}</td>
									<td class="py-2 text-[var(--color-text-secondary)] truncate max-w-[200px]">
										{entry.metadata ? JSON.stringify(entry.metadata) : "-"}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="md:hidden">
					<MobileCardStack columns={auditColumns} rows={auditRows} keyField="id" />
				</div>

				{#if hasMoreAudit}
					<button
						onclick={() => loadAuditLog()}
						disabled={loadingAudit}
						class="mt-3 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50 transition-colors"
					>
						{loadingAudit ? "Loading..." : "Load more"}
					</button>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- Providers -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
		<button
			onclick={() => providersExpanded = !providersExpanded}
			class="flex w-full items-center justify-between p-6"
		>
			<h2 class="text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
				Providers
			</h2>
			<div class="flex items-center gap-2">
				{#each providerStatuses as p}
					<span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
						<span class="h-2 w-2 rounded-full {getStatusDotColor(p)}"></span>
						{PROVIDER_META[p.provider]?.name ?? p.provider}
					</span>
				{/each}
				<span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
					<span class="h-2 w-2 rounded-full {ollamaConnected ? 'bg-green-500' : 'bg-gray-500'}"></span>
					Ollama
				</span>
				<svg class="h-5 w-5 text-[var(--color-text-secondary)] transition-transform duration-200 {providersExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
			</div>
		</button>
		{#if providersExpanded}
			<div class="border-t border-[var(--color-border)] p-6 pt-4">
				<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Manage your API keys and subscriptions for each LLM provider.</p>
				<ProviderSettings bind:statuses={providerStatuses} />

				<!-- Ollama (Local) -->
				<div class="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
					<div class="flex items-center gap-4">
						<ProviderIcon provider="ollama" size="lg" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">Ollama (Local)</span>
								{#if ollamaConnected}
									<span class="inline-flex items-center gap-1 text-xs">
										<span class="h-2 w-2 rounded-full bg-green-500"></span>
										<span class="text-green-400">{ollamaCustomModels.length} model{ollamaCustomModels.length !== 1 ? 's' : ''}</span>
									</span>
								{:else}
									<span class="inline-flex items-center gap-1 text-xs">
										<span class="h-2 w-2 rounded-full bg-gray-500"></span>
										<span class="text-[var(--color-text-muted)]">Not configured</span>
									</span>
								{/if}
							</div>

							<!-- URL config -->
							<div class="mt-2">
								<label for="settings-ollama-base-url" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL</label>
								<div class="flex items-center gap-2">
									<input
										id="settings-ollama-base-url"
										type="text"
										bind:value={ollamaUrl}
										placeholder="e.g. http://localhost:11434"
										class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
									/>
									<button
										onclick={saveOllamaUrl}
										disabled={savingOllamaUrl}
										class="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
									>
										{savingOllamaUrl ? "Saving..." : "Save URL"}
									</button>
									<button
										onclick={fetchOllamaModels}
										disabled={ollamaFetching || !ollamaUrl.trim()}
										class="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors"
									>
										{ollamaFetching ? "Fetching..." : "Fetch Models"}
									</button>
								</div>
							</div>

							{#if ollamaError}
								<p class="mt-1.5 text-xs text-red-400">{ollamaError}</p>
								{#if ollamaError.includes("not reachable")}
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">If running in Docker, set <code class="bg-[var(--color-surface-tertiary)] px-1 rounded">OLLAMA_HOST=0.0.0.0</code> on the host and use <code class="bg-[var(--color-surface-tertiary)] px-1 rounded">http://host.docker.internal:11434</code> as the URL.</p>
								{/if}
							{/if}

							<!-- Discovered models (not yet added) -->
							{#if ollamaModels.length > 0}
								<div class="mt-2">
									<p class="mb-1 text-xs text-[var(--color-text-secondary)]">Available models:</p>
									<div class="space-y-1">
										{#each ollamaModels as m}
											{@const alreadyAdded = ollamaCustomModels.some((cm) => cm.modelId === m.id)}
											<div class="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5">
												<span class="flex-1 text-xs text-[var(--color-text-primary)] truncate">{m.name ?? m.id}</span>
												{#if alreadyAdded}
													<span class="text-xs text-green-400">Added</span>
												{:else}
													<button
														onclick={() => addOllamaModel(m.id)}
														disabled={ollamaAddingModel === m.id}
														class="rounded-md bg-purple-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors"
													>
														{ollamaAddingModel === m.id ? "Adding..." : "Add"}
													</button>
												{/if}
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Active Ollama models -->
							{#if ollamaCustomModels.length > 0}
								<div class="mt-3 border-t border-[var(--color-border)] pt-3">
									<p class="mb-1 text-xs text-[var(--color-text-secondary)]">Active models:</p>
									<div class="space-y-1">
										{#each ollamaCustomModels as cm}
											<div class="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5">
												<span class="flex-1 text-xs text-[var(--color-text-primary)] truncate">{cm.modelId}</span>
												<button
													onclick={() => handleTestOllamaModel(cm.modelId)}
													disabled={ollamaTestResults[cm.modelId] === "testing"}
													class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
												>
													{ollamaTestResults[cm.modelId] === "testing" ? "Testing..." : "Test"}
												</button>
												{#if ollamaTestResults[cm.modelId] && ollamaTestResults[cm.modelId] !== "testing"}
													{@const r = ollamaTestResults[cm.modelId] as import("$lib/api.js").LocalModelCheckResult}
													<span class="flex items-center gap-1 text-xs">
														<span title="Reachable" class={r.reachable ? "text-green-400" : "text-red-400"}>{r.reachable ? "\u2713" : "\u2717"}</span>
														{#if r.modelAvailable !== null}
															<span title="Model available" class={r.modelAvailable ? "text-green-400" : "text-red-400"}>{r.modelAvailable ? "\u2713" : "\u2717"}</span>
														{/if}
														{#if r.inferenceOk !== null}
															<span title="Inference OK" class={r.inferenceOk ? "text-green-400" : "text-red-400"}>{r.inferenceOk ? "\u2713" : "\u2717"}</span>
														{/if}
														{#if r.latencyMs !== undefined}
															<span class="text-[var(--color-text-muted)]">{r.latencyMs}ms</span>
														{/if}
													</span>
												{/if}
												<button
													onclick={() => removeOllamaModel(cm.modelId)}
													class="text-xs text-red-400 hover:text-red-300 transition-colors"
												>
													Remove
												</button>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Default Model Tier -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Default Model Tier <InfoTooltip text="Controls which quality tier is used when a conversation doesn't specify a model. 'Fast' uses cheaper, lower-latency models. 'Balanced' is the default middle ground. 'Powerful' uses the most capable (and expensive) models. Overridden by any explicit model selection in a conversation." /></h2>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">Choose the default tier when no model is explicitly selected.</p>
		<div class="flex items-center gap-1">
			{#each TIERS as tier}
				<button
					onclick={() => { defaultTier = tier; }}
					class="rounded-md px-4 py-2 text-sm font-medium transition-colors
						{defaultTier === tier
							? 'bg-blue-600 text-white'
							: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
				>
					{tier.charAt(0).toUpperCase() + tier.slice(1)}
				</button>
			{/each}
		</div>
		<button
			onclick={saveTier}
			disabled={savingTier}
			class="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{savingTier ? "Saving..." : "Save Tier"}
		</button>
	</div>

	<!-- Provider Preference Order -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Provider Preference Order <InfoTooltip text="When multiple providers have keys configured, this determines which provider is tried first for a given tier. If the first provider fails or is unavailable, the next in order is used as a fallback. Reorder to match your preference for cost, speed, or quality." /></h2>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">Set the order in which providers are tried during routing. Drag or use arrows to reorder.</p>
		<div class="space-y-2">
			{#each preferenceOrder as provider, i}
				<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
					<span class="text-sm font-medium text-[var(--color-text-secondary)] w-5">{i + 1}.</span>
					<span class="flex-1 text-sm text-[var(--color-text-primary)]">{PROVIDER_META[provider]?.name ?? provider}</span>
					<div class="flex gap-1">
						<button
							onclick={() => moveProvider(i, -1)}
							disabled={i === 0}
							class="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
							title="Move up"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
							</svg>
						</button>
						<button
							onclick={() => moveProvider(i, 1)}
							disabled={i === preferenceOrder.length - 1}
							class="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
							title="Move down"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
							</svg>
						</button>
					</div>
				</div>
			{/each}
		</div>
		<button
			onclick={saveOrder}
			disabled={savingOrder}
			class="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{savingOrder ? "Saving..." : "Save Order"}
		</button>
	</div>

	<!-- Custom Models -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Custom Models <InfoTooltip text="Register model IDs that aren't in the built-in registry. You must specify which provider serves the model and which tier it belongs to. Custom models appear alongside built-in models in the model selector and follow the same routing rules." /></h2>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">Add model IDs not in the default registry.</p>

		{#if customModels.length > 0}
			<div class="mb-4 space-y-2">
				{#each customModels as cm}
					<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
						<span class="flex-1 text-sm text-[var(--color-text-primary)] truncate">{cm.modelId}</span>
						<span class="text-xs text-[var(--color-text-secondary)]">{cm.provider}</span>
						<span class="text-xs text-[var(--color-text-muted)]">{cm.tier}</span>
						{#if cm.baseUrl}
							<span class="text-xs text-[var(--color-text-muted)] truncate max-w-[200px]" title={cm.baseUrl}>{cm.baseUrl}</span>
							<button
								onclick={() => handleTestLocalModel(cm.modelId, cm.baseUrl!)}
								disabled={localTestResults[cm.modelId] === "testing"}
								class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
							>
								{localTestResults[cm.modelId] === "testing" ? "Testing..." : "Test"}
							</button>
							{#if localTestResults[cm.modelId] && localTestResults[cm.modelId] !== "testing"}
								{@const r = localTestResults[cm.modelId] as import("$lib/api.js").LocalModelCheckResult}
								<span class="flex items-center gap-1 text-xs">
									<span title="Reachable" class={r.reachable ? "text-green-400" : "text-red-400"}>{r.reachable ? "\u2713" : "\u2717"}</span>
									{#if r.modelAvailable !== null}
										<span title="Model available" class={r.modelAvailable ? "text-green-400" : "text-red-400"}>{r.modelAvailable ? "\u2713" : "\u2717"}</span>
									{/if}
									{#if r.inferenceOk !== null}
										<span title="Inference OK" class={r.inferenceOk ? "text-green-400" : "text-red-400"}>{r.inferenceOk ? "\u2713" : "\u2717"}</span>
									{/if}
									{#if r.latencyMs !== undefined}
										<span class="text-[var(--color-text-muted)]">{r.latencyMs}ms</span>
									{/if}
								</span>
							{/if}
						{/if}
						<button
							onclick={() => removeCustomModel(cm.modelId)}
							class="text-xs text-red-400 hover:text-red-300 transition-colors"
						>
							Remove
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] items-end gap-2">
			<div>
				<label for="settings-new-model-provider" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Provider</label>
				<select
					id="settings-new-model-provider"
					bind:value={newModelProvider}
					aria-label="Model provider"
					onchange={() => { discoveredModels = []; discoveryError = null; newModelId = ""; if (newModelProvider === "ollama" && !newModelBaseUrl) newModelBaseUrl = "http://localhost:11434"; }}
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					{#each PROVIDERS as p}
						<option value={p}>{PROVIDER_META[p]?.name ?? p}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="settings-new-model-tier" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Tier</label>
				<select
					id="settings-new-model-tier"
					bind:value={newModelTier}
					aria-label="Model tier"
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					{#each TIERS as t}
						<option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
					{/each}
				</select>
			</div>
			{#if !isLocalProvider}
				<div class="md:col-span-1"></div>
			{/if}
		</div>

		{#if isLocalProvider}
			<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_auto] items-end gap-2">
				<div>
					<label for="settings-new-model-base-url-discovery" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL</label>
					<input
						id="settings-new-model-base-url-discovery"
						type="text"
						bind:value={newModelBaseUrl}
						placeholder="e.g. http://localhost:11434"
						onchange={() => { discoveredModels = []; discoveryError = null; newModelId = ""; }}
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>
				<button
					onclick={discoverModels}
					disabled={discoveringModels || !newModelBaseUrl.trim()}
					class="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors"
				>
					{discoveringModels ? "Fetching..." : "Fetch Models"}
				</button>
			</div>

			{#if discoveryError}
				<p class="mt-1 text-xs text-red-400">{discoveryError}</p>
			{/if}

			{#if discoveredModels.length > 0}
				<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_auto] items-end gap-2">
					<div>
						<label for="settings-new-model-discovered" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Model</label>
						<select
							id="settings-new-model-discovered"
							bind:value={newModelId}
							aria-label="Discovered model"
							class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						>
							{#each discoveredModels as m}
								<option value={m.id}>{m.name ?? m.id}</option>
							{/each}
						</select>
					</div>
					<button
						onclick={addCustomModel}
						disabled={savingCustom || !newModelId.trim()}
						class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
					>
						Add
					</button>
				</div>
			{/if}
		{:else}
			<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] items-end gap-2">
				<div>
					<label for="settings-new-model-id" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Model ID</label>
					<input
						id="settings-new-model-id"
						type="text"
						bind:value={newModelId}
						placeholder="e.g. gpt-4-turbo-preview"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>
				<div>
					<label for="settings-new-model-base-url" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL (optional)</label>
					<input
						id="settings-new-model-base-url"
						type="text"
						bind:value={newModelBaseUrl}
						placeholder="e.g. http://localhost:11434"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>
				<button
					onclick={addCustomModel}
					disabled={savingCustom || !newModelId.trim()}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
				>
					Add
				</button>
			</div>
		{/if}
	</div>

	<!-- Global Custom Instructions -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Global Custom Instructions <InfoTooltip text="A system prompt prepended to every conversation across all projects. This is the lowest priority instruction level. Overridden by project-level instructions, which are in turn overridden by conversation-level instructions." /></h2>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">Default system prompt for all conversations across all projects. Lowest priority.</p>
		<textarea
			bind:value={globalPrompt}
			rows={4}
			class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
			placeholder="e.g. You are a helpful AI assistant..."
		></textarea>
		<button
			onclick={saveGlobalPrompt}
			disabled={savingPrompt}
			class="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{savingPrompt ? "Saving..." : "Save Global Instructions"}
		</button>
	</div>

	<!-- Custom Modes -->
	<div id="modes" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<div class="flex items-center justify-between mb-1">
			<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">Custom Modes</h2>
			<button
				onclick={openCreateMode}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
			>
				Create Mode
			</button>
		</div>
		<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Behavioral presets that modify system prompt, tool availability, and model preferences per conversation.</p>

		{#if allModes.length === 0}
			<p class="text-xs text-[var(--color-text-muted)]">No modes yet. Create one or modes will be seeded on restart.</p>
		{:else}
			<div class="space-y-2">
				{#each allModes as mode}
					<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 hover:border-[var(--color-accent)] transition-colors">
						<button
							type="button"
							onclick={() => openViewMode(mode)}
							class="flex flex-1 items-center gap-3 min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded"
							aria-label={`View ${mode.name} mode`}
						>
							<span class="text-lg">{mode.icon ?? ''}</span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-[var(--color-text-primary)]">{mode.name}</span>
									{#if mode.builtin}
										<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">built-in</span>
									{/if}
									<!-- Built-in modes (e.g. Ez) still rely on toolRestriction for filtering;
									     keep the legacy badge for them. User-authored modes now express
									     restrictions via attached extensions instead. -->
									{#if mode.builtin && mode.toolRestriction !== "all"}
										<span class="rounded bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-400">{mode.toolRestriction === "read-only" ? "read-only" : "no tools"}</span>
									{/if}
									{#if (mode.extensionIds?.length ?? 0) > 0}
										<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
											{mode.extensionIds!.length} extension{mode.extensionIds!.length === 1 ? '' : 's'}
										</span>
									{/if}
								</div>
								<p class="text-xs text-[var(--color-text-secondary)] truncate">{mode.description}</p>
							</div>
						</button>
						{#if !mode.builtin}
							<button onclick={(e) => { e.stopPropagation(); handleDeleteMode(mode.id); }} class="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

	</div>

	<ModeFormModal
		open={showModeModal}
		editMode={editingMode}
		viewMode={modeViewMode}
		onclose={() => { showModeModal = false; editingMode = null; modeViewMode = false; }}
		onsaved={handleModeSaved}
	/>

	<!-- Admin: Security Settings -->
	{#if currentUser?.role === "admin"}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Security <InfoTooltip text="Configure rate limits, daily token budgets, and storage quotas. These settings apply globally to all users." /></h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Rate limits, token budgets, and storage quotas.</p>
			<SecuritySettings />
		</div>

		<!-- Admin: System Health -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">System Health</h2>
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Live subsystem status with auto-refresh.</p>
			<SystemHealth />
		</div>
	{/if}

	<!-- Developer: API Keys -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Developer <InfoTooltip text="Create API keys for programmatic access. Each key can have specific scopes (read, chat, extensions, admin) to limit what it can access." /></h2>
		<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Manage API keys for external tools, scripts, and CI pipelines.</p>
		<ApiKeyManager />
	</div>

	<!-- Audit & Visibility (Phase 52.5) -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6" data-testid="settings-audit-visibility">
		<button
			type="button"
			class="flex w-full items-center justify-between text-left"
			onclick={() => (auditSectionOpen = !auditSectionOpen)}
			aria-expanded={auditSectionOpen}
		>
			<h2 class="text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
				Audit &amp; Visibility
				<InfoTooltip text="Controls which capability events appear inline in chat and how often event-subscription deliveries are audited. The audit trail is always written to the database; these toggles only affect what the UI shows you." />
			</h2>
			<span class="text-xs text-[var(--color-text-muted)]">{auditSectionOpen ? "Hide" : "Show"}</span>
		</button>
		<p class="mt-1 text-xs text-[var(--color-text-secondary)]">Hide chatty extension pills without losing the audit trail.</p>

		{#if auditSectionOpen}
			<div class="mt-4 space-y-4">
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Show built-in capability events in chat</p>
						<p class="text-xs text-[var(--color-text-muted)]">First-party extensions (lessons-keeper, memory-extractor, …). Default: on.</p>
					</div>
					<button
						onclick={toggleBuiltinPills}
						disabled={savingPills}
						class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showBuiltinPills ? 'bg-blue-600' : 'bg-gray-600'}"
						role="switch"
						aria-checked={showBuiltinPills}
						aria-label="Toggle built-in pill visibility"
						data-testid="toggle-builtin-pills"
					>
						<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showBuiltinPills ? 'translate-x-5' : 'translate-x-0'}"></span>
					</button>
				</div>

				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Show installed-extension capability events in chat</p>
						<p class="text-xs text-[var(--color-text-muted)]">Third-party extensions you installed yourself. Default: off (they can be chatty).</p>
					</div>
					<button
						onclick={toggleInstalledPills}
						disabled={savingPills}
						class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showInstalledPills ? 'bg-blue-600' : 'bg-gray-600'}"
						role="switch"
						aria-checked={showInstalledPills}
						aria-label="Toggle installed-extension pill visibility"
						data-testid="toggle-installed-pills"
					>
						<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showInstalledPills ? 'translate-x-5' : 'translate-x-0'}"></span>
					</button>
				</div>

				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-sm text-[var(--color-text-primary)]">Event-delivery audit sample rate (1-in-N)</p>
						<p class="text-xs text-[var(--color-text-muted)]">Sampled audit rows for ctx.events deliveries. Lower = more rows, higher cost. Range 1–10000.</p>
					</div>
					<input
						type="number"
						min="1"
						max="10000"
						bind:value={eventAuditSampleN}
						onchange={() => saveEventAuditSampleN()}
						class="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
						data-testid="input-event-audit-sample"
					/>
				</div>
			</div>
		{/if}
	</div>

	<!-- Advanced -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">Advanced <InfoTooltip text="Advanced settings for debugging and development. These control optional features that expose additional internal information in the UI." /></h2>
		<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Advanced features and debugging tools.</p>
		<div class="flex items-center justify-between">
			<div>
				<p class="text-sm text-[var(--color-text-primary)] flex items-center gap-2">Show Observability <InfoTooltip text="When enabled, an 'Inspect' button appears on chat messages showing tool call traces, token usage, latency, and provider details. Useful for debugging and understanding how the AI processes requests. No effect on AI behavior." /></p>
				<p class="text-xs text-[var(--color-text-secondary)]">Display the inspect button in chat for tool call traces and token usage.</p>
			</div>
			<button
				onclick={toggleObservability}
				disabled={savingObs}
				class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showObservability ? 'bg-blue-600' : 'bg-gray-600'}"
				role="switch"
				aria-checked={showObservability}
				aria-label="Toggle observability"
			>
				<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showObservability ? 'translate-x-5' : 'translate-x-0'}"></span>
			</button>
		</div>
		<div class="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-4">
			<div>
				<p class="text-sm text-[var(--color-text-primary)] flex items-center gap-2">Agent goal pinning &amp; autonomous continuation <InfoTooltip text="When enabled, spawned sub-agents get their objective pinned into the system prompt every cycle and may opt into self-continuation (re-prompting themselves until done). Turn OFF to revert agents to the prior one-shot behavior — no pinned objective, no autonomous looping, regardless of any per-task opt-in." /></p>
				<p class="text-xs text-[var(--color-text-secondary)]">Off reverts spawned agents to the prior one-shot behavior across all task/agent spawns.</p>
			</div>
			<button
				onclick={toggleAgentAutonomy}
				disabled={savingAutonomy}
				class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {agentAutonomyEnabled ? 'bg-blue-600' : 'bg-gray-600'}"
				role="switch"
				aria-checked={agentAutonomyEnabled}
				aria-label="Toggle agent goal pinning and autonomous continuation"
				data-testid="toggle-agent-autonomy"
			>
				<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {agentAutonomyEnabled ? 'translate-x-5' : 'translate-x-0'}"></span>
			</button>
		</div>
	</div>
	{/if}
</div>
