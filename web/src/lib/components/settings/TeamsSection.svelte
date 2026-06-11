<script lang="ts">
	import { onMount } from "svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	type UserEntry = { id: string; email: string; name: string; role: string; status: string };
	type TeamEntry = { id: string; name: string; createdAt: string; role?: string };
	type TeamMemberEntry = { id: string; userId: string; userName: string; userEmail: string; role: string };

	let allUsers = $state<UserEntry[]>([]);
	let allTeams = $state<TeamEntry[]>([]);
	let loadingTeams = $state(true);
	let newTeamName = $state("");
	let expandedTeamId = $state<string | null>(null);
	let teamMembers = $state<Record<string, TeamMemberEntry[]>>({});
	let addMemberUserId = $state("");
	let addMemberRole = $state<"viewer" | "editor" | "owner">("viewer");

	async function loadUsers() {
		try {
			const res = await fetch("/api/users");
			if (res.ok) {
				const data = await res.json();
				allUsers = data.users;
			}
		} catch { /* silent */ }
	}

	async function loadTeams() {
		try {
			const res = await fetch("/api/teams");
			if (res.ok) {
				const data = await res.json();
				allTeams = data.teams;
			}
		} catch { /* silent */ }
		loadingTeams = false;
	}

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

	onMount(() => {
		loadTeams();
		loadUsers();
	});
</script>

<SettingsSection
	id="teams"
	title="Teams"
	description="Create and manage teams. Agents, memories, and KB files are shared to teams."
>
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
</SettingsSection>
