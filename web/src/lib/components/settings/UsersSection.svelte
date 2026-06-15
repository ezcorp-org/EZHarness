<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	type CurrentUser = { id: string; email: string; name: string; role: "admin" | "member" };
	type UserEntry = { id: string; email: string; name: string; role: string; status: string };
	type AdminSessionEntry = {
		id: string;
		userId: string;
		userName: string | null;
		userEmail: string | null;
		userAgent: string | null;
		ipAddress: string | null;
		lastActiveAt: string | null;
		createdAt: string;
	};

	let { currentUser }: { currentUser: CurrentUser | null } = $props();

	let allUsers = $state<UserEntry[]>([]);
	let loadingUsers = $state(true);
	let usersError = $state(false);
	let copiedResetUserId = $state<string | null>(null);

	// Settings v2 — server-side pagination (opt-in). We fetch one
	// USERS_PAGE_SIZE page at a time via /api/users?limit&offset&q; the
	// server `total` drives the pager and search is server-side (debounced
	// `q`). `allUsers` accumulates the pages fetched so far.
	const USERS_PAGE_SIZE = 20;
	const SEARCH_DEBOUNCE_MS = 300;
	let userQuery = $state("");
	let totalUsers = $state(0);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	const visibleUsers = $derived(allUsers);
	// More to fetch when we've shown fewer rows than the server reports.
	const hasMoreUsers = $derived(allUsers.length < totalUsers);

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

	/**
	 * Fetch one page from the server. `reset` clears the accumulated list
	 * and starts at offset 0 (used on initial load + whenever `q` changes);
	 * otherwise it appends the next page.
	 */
	async function loadUsers(reset = true) {
		// Distinguish "fetch failed" from "no users exist" — a failed
		// request must not masquerade as an empty directory.
		if (reset) loadingUsers = true;
		const offset = reset ? 0 : allUsers.length;
		const params = new URLSearchParams({
			limit: String(USERS_PAGE_SIZE),
			offset: String(offset),
		});
		const q = userQuery.trim();
		if (q) params.set("q", q);
		try {
			const res = await fetch(`/api/users?${params}`);
			if (res.ok) {
				const data = await res.json();
				const page: UserEntry[] = data.users ?? [];
				allUsers = reset ? page : [...allUsers, ...page];
				// Server returns `total` for the paged contract; fall back to
				// the page length if a caller (or a test stub) omits it.
				totalUsers = typeof data.total === "number" ? data.total : allUsers.length;
				usersError = false;
			} else {
				usersError = true;
			}
		} catch {
			usersError = true;
		}
		loadingUsers = false;
	}

	function onSearchInput() {
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => loadUsers(true), SEARCH_DEBOUNCE_MS);
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

	onMount(() => {
		loadUsers();
		loadAdminSessions();
	});

	onDestroy(() => {
		if (searchTimer) clearTimeout(searchTimer);
	});
</script>

<SettingsSection
	id="users"
	title="Users"
	description="Manage user accounts. Deactivating a user transfers their agents to you."
>
	{#if forceLogoutMessage}
		<p class="mb-3 text-xs {forceLogoutMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}">{forceLogoutMessage.text}</p>
	{/if}
	{#if loadingUsers}
		<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
	{:else if usersError}
		<p class="text-sm text-red-400" data-testid="users-load-error">
			Failed to load users.
			<button onclick={() => loadUsers()} class="ml-1 text-blue-400 hover:text-blue-300 transition-colors">Retry</button>
		</p>
	{:else if allUsers.length === 0 && !userQuery.trim()}
		<p class="text-sm text-[var(--color-text-secondary)]">No users found.</p>
	{:else}
		<input
			type="search"
			bind:value={userQuery}
			oninput={onSearchInput}
			placeholder="Search by name or email..."
			aria-label="Search users"
			data-testid="users-search"
			class="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
		/>
		{#if allUsers.length === 0}
			<p class="text-sm text-[var(--color-text-secondary)]">No users match "{userQuery}".</p>
		{/if}
		<div class="space-y-2">
			{#each visibleUsers as u}
				<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
					<div class="flex flex-wrap items-center gap-2 md:gap-3">
						<div class="flex-1 min-w-0 basis-full md:basis-auto">
							<p class="text-sm text-[var(--color-text-primary)] truncate">{u.name}</p>
							<p class="text-xs text-[var(--color-text-secondary)] truncate">{u.email}</p>
						</div>
						<!-- Locked decision 8 — badge noise: only non-default values render -->
						{#if (sessionCountByUser[u.id] ?? 0) > 0}
							<span class="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]" title="Active sessions">{sessionCountByUser[u.id]} sessions</span>
						{/if}
						{#if u.role !== "member"}
							<span class="text-xs px-2 py-0.5 rounded-full {u.role === 'admin' ? 'bg-purple-900 text-purple-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">{u.role}</span>
						{/if}
						{#if u.status !== "active"}
							<span class="text-xs px-2 py-0.5 rounded-full bg-red-900 text-red-300">{u.status}</span>
						{/if}
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
		{#if hasMoreUsers}
			<button
				onclick={() => loadUsers(false)}
				data-testid="users-load-more"
				class="mt-3 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
			>
				Load more ({totalUsers - allUsers.length} remaining)
			</button>
		{/if}
	{/if}
</SettingsSection>
