<script lang="ts">
	import { onMount } from "svelte";
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
	let copiedResetUserId = $state<string | null>(null);

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

	async function loadUsers() {
		try {
			const res = await fetch("/api/users");
			if (res.ok) {
				const data = await res.json();
				allUsers = data.users;
			}
		} catch { /* silent */ }
		loadingUsers = false;
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
</SettingsSection>
