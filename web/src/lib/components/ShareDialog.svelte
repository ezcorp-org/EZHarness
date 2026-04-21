<script lang="ts">
	type ShareEntry = { teamId: string; teamName: string; sharedBy: string; sharedByName: string; createdAt: string };
	type TeamEntry = { id: string; name: string; createdAt: string; role?: string };

	let {
		agentId,
		agentName,
		open = false,
		onClose,
	}: {
		agentId: string;
		agentName: string;
		open: boolean;
		onClose: () => void;
	} = $props();

	let teams = $state<TeamEntry[]>([]);
	let currentShares = $state<ShareEntry[]>([]);
	let selectedTeamIds = $state<Set<string>>(new Set());
	let loading = $state(false);
	let saving = $state(false);
	let error = $state("");

	async function loadData() {
		loading = true;
		error = "";
		try {
			const [teamsRes, sharesRes] = await Promise.all([
				fetch("/api/teams"),
				fetch(`/api/agents/${agentId}/share`),
			]);
			if (teamsRes.ok) {
				const data = await teamsRes.json();
				teams = data.teams;
			}
			if (sharesRes.ok) {
				const data = await sharesRes.json();
				currentShares = data.shares;
			}
			// Pre-select currently shared teams
			selectedTeamIds = new Set(currentShares.map((s) => s.teamId));
		} catch {
			error = "Failed to load sharing data";
		}
		loading = false;
	}

	$effect(() => {
		if (open) {
			loadData();
		}
	});

	function toggleTeam(teamId: string) {
		const next = new Set(selectedTeamIds);
		if (next.has(teamId)) {
			next.delete(teamId);
		} else {
			next.add(teamId);
		}
		selectedTeamIds = next;
	}

	async function handleShare() {
		saving = true;
		error = "";
		try {
			const currentlyShared = new Set(currentShares.map((s) => s.teamId));

			// Teams to add
			const toAdd = [...selectedTeamIds].filter((id) => !currentlyShared.has(id));
			// Teams to remove
			const toRemove = [...currentlyShared].filter((id) => !selectedTeamIds.has(id));

			if (toAdd.length > 0) {
				const res = await fetch(`/api/agents/${agentId}/share`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teamIds: toAdd }),
				});
				if (!res.ok) {
					const data = await res.json();
					error = data.error ?? "Failed to share";
					saving = false;
					return;
				}
			}

			for (const teamId of toRemove) {
				await fetch(`/api/agents/${agentId}/share`, {
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teamId }),
				});
			}

			onClose();
		} catch {
			error = "Failed to update sharing";
		}
		saving = false;
	}

	function handleBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onClose();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onclick={handleBackdrop}
		onkeydown={handleKeydown}
		role="dialog"
		aria-modal="true"
		aria-label="Share agent with teams"
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Share "{agentName}"</h3>
				<button
					onclick={onClose}
					class="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
					aria-label="Close"
				>
					<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			{#if error}
				<p class="mb-3 text-sm text-red-400">{error}</p>
			{/if}

			{#if loading}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading teams...</p>
			{:else if teams.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]">No teams available. Create a team first in Settings.</p>
			{:else}
				<p class="mb-3 text-xs text-[var(--color-text-secondary)]">Select teams to share this agent with. Team members will see it in their agent list.</p>
				<div class="max-h-60 space-y-1 overflow-y-auto">
					{#each teams as team}
						<button
							onclick={() => toggleTeam(team.id)}
							class="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors {selectedTeamIds.has(team.id)
								? 'border-blue-500 bg-blue-900/30'
								: 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border)]'}"
						>
							<span class="flex h-5 w-5 items-center justify-center rounded border {selectedTeamIds.has(team.id) ? 'border-blue-500 bg-blue-600' : 'border-[var(--color-border)]'}">
								{#if selectedTeamIds.has(team.id)}
									<svg class="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
									</svg>
								{/if}
							</span>
							<span class="text-sm text-[var(--color-text-primary)]">{team.name}</span>
						</button>
					{/each}
				</div>

				<div class="mt-4 flex justify-end gap-2">
					<button
						onclick={onClose}
						class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
					>
						Cancel
					</button>
					<button
						onclick={handleShare}
						disabled={saving}
						class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
					>
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
