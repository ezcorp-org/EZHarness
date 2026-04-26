<script lang="ts">
	import { addToast } from "$lib/toast.svelte.js";

	type ShareEntry = {
		id: string;
		teamId: string | null;
		teamName: string | null;
		userId: string | null;
		recipientName: string | null;
		permission: "read" | "edit";
		sharedBy: string;
		sharedByName: string;
		createdAt: string;
	};

	let {
		agentId,
		agentName,
		open = false,
		onclose,
	}: {
		agentId: string;
		agentName: string;
		open: boolean;
		onclose: () => void;
	} = $props();

	let currentShares = $state<ShareEntry[]>([]);
	let userSearch = $state("");
	let permission = $state<"read" | "edit">("read");
	let loading = $state(false);
	let sharing = $state(false);

	async function loadShares() {
		loading = true;
		try {
			const res = await fetch(`/api/agents/${agentId}/share`);
			if (res.ok) {
				const data = await res.json();
				currentShares = data.shares;
			}
		} catch {
			// ignore
		}
		loading = false;
	}

	$effect(() => {
		if (open) loadShares();
	});

	async function handleShare() {
		const query = userSearch.trim();
		if (!query) return;
		sharing = true;
		try {
			// Search for user by email/name first
			const searchRes = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
			if (!searchRes.ok) {
				addToast({ type: "error", message: "User not found" });
				sharing = false;
				return;
			}
			const searchData = await searchRes.json();
			const users = searchData.users as Array<{ id: string; name: string; email: string }>;
			if (!users || users.length === 0) {
				addToast({ type: "error", message: "User not found" });
				sharing = false;
				return;
			}

			const targetUser = users[0]!;
			const res = await fetch(`/api/agents/${agentId}/share`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userIds: [targetUser.id], permission }),
			});
			if (!res.ok) {
				const data = await res.json();
				addToast({ type: "error", message: data.error ?? "Failed to share" });
				sharing = false;
				return;
			}
			addToast({ type: "success", message: "Agent shared" });
			userSearch = "";
			await loadShares();
		} catch {
			addToast({ type: "error", message: "Failed to share agent" });
		}
		sharing = false;
	}

	async function removeShare(entry: ShareEntry) {
		try {
			const body: Record<string, string> = {};
			if (entry.teamId) body.teamId = entry.teamId;
			if (entry.userId) body.userId = entry.userId;
			const res = await fetch(`/api/agents/${agentId}/share`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error();
			currentShares = currentShares.filter((s) => s.id !== entry.id);
			addToast({ type: "success", message: "Share removed" });
		} catch {
			addToast({ type: "error", message: "Failed to remove share" });
		}
	}

	function handleBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onclose();
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
		aria-label="Share agent"
		tabindex={-1}
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Share "{agentName}"</h3>
				<button
					onclick={onclose}
					class="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
					aria-label="Close"
				>
					<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Share form -->
			<div class="mb-4 space-y-3">
				<div>
					<label for="share-user" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Username or email</label>
					<input
						id="share-user"
						type="text"
						bind:value={userSearch}
						placeholder="Enter username or email..."
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						onkeydown={(e) => { if (e.key === "Enter") handleShare(); }}
					/>
				</div>
				<div>
					<label for="share-permission" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Permission</label>
					<div class="flex gap-2">
						<button
							onclick={() => (permission = "read")}
							class="flex-1 rounded-md border px-3 py-2 text-sm transition-colors {permission === 'read' ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border)]'}"
						>
							Can use
						</button>
						<button
							onclick={() => (permission = "edit")}
							class="flex-1 rounded-md border px-3 py-2 text-sm transition-colors {permission === 'edit' ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border)]'}"
						>
							Can edit
						</button>
					</div>
				</div>
				<button
					onclick={handleShare}
					disabled={!userSearch.trim() || sharing}
					class="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
				>
					{sharing ? "Sharing..." : "Share"}
				</button>
			</div>

			<!-- Existing shares -->
			{#if loading}
				<p class="text-sm text-[var(--color-text-secondary)]">Loading shares...</p>
			{:else if currentShares.length > 0}
				<div class="border-t border-[var(--color-border)] pt-3">
					<p class="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">Current shares</p>
					<div class="max-h-48 space-y-1 overflow-y-auto">
						{#each currentShares as share (share.id)}
							<div class="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
								<div class="min-w-0">
									<span class="text-sm text-[var(--color-text-primary)]">{share.recipientName ?? share.teamName ?? "Unknown"}</span>
									<span class="ml-2 rounded px-1.5 py-0.5 text-xs {share.permission === 'edit' ? 'bg-blue-900/40 text-blue-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">
										{share.permission === "edit" ? "Can edit" : "Can use"}
									</span>
								</div>
								<button
									onclick={() => removeShare(share)}
									class="shrink-0 text-[var(--color-text-muted)] transition-colors hover:text-red-400"
									aria-label="Remove share"
								>
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
