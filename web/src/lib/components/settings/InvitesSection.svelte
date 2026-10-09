<script lang="ts">
	import { onMount } from "svelte";
	import { createInviteSchema } from "../../../routes/api/auth/invite/schema";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	type InviteEntry = { id: string; email: string | null; token: string; role: string; expiresAt: string; usedAt: string | null };

	let allInvites = $state<InviteEntry[]>([]);
	let loadingInvites = $state(true);
	let inviteEmail = $state("");
	let inviteEmailValid = $derived(createInviteSchema.shape.email.safeParse(inviteEmail).success);
	let inviteRole = $state<"admin" | "member">("member");
	let copiedInviteId = $state<string | null>(null);

	async function loadInvites() {
		try {
			const res = await fetch("/api/auth/invite");
			if (res.ok) {
				const data = await res.json();
				allInvites = data.invites;
			}
		} catch { /* silent */ }
		loadingInvites = false;
	}

	async function createInvite() {
		if (!inviteEmailValid) return;
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
		const res = await fetch("/api/auth/invite", { method: "DELETE",
			headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: inviteId }) });
		if (res.ok) await loadInvites();
	}

	function copyInviteLink(invite: InviteEntry) {
		const url = `${window.location.origin}/signup/${invite.token}`;
		navigator.clipboard.writeText(url);
		copiedInviteId = invite.id;
		setTimeout(() => { copiedInviteId = null; }, 2000);
	}

	onMount(() => {
		loadInvites();
	});
</script>

<SettingsSection
	id="invites"
	title="Invites"
	description="Create invite links for new users. Links expire after 7 days."
>
	<!-- Create invite form -->
	<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-end">
		<div class="flex-1">
			<label for="settings-invite-email" class="block text-xs text-[var(--color-text-secondary)] mb-1">Email (required)</label>
			<input id="settings-invite-email" type="email" required aria-describedby="invite-email-help" autocomplete="off" bind:value={inviteEmail} placeholder="user@example.com" class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none" />
		</div>
		<div>
			<label for="invite-role" class="block text-xs text-[var(--color-text-secondary)] mb-1">Role</label>
			<select id="invite-role" bind:value={inviteRole} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
				<option value="member">Member</option>
				<option value="admin">Admin</option>
			</select>
		</div>
		<button onclick={createInvite} disabled={!inviteEmailValid} class="disabled:opacity-50 disabled:cursor-not-allowed rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors">Create Invite</button>
	</div>

	<p id="invite-email-help" class="text-xs text-[var(--color-text-muted)] mt-1 mb-4">Enter a valid email address to create an invite.</p>

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
</SettingsSection>
