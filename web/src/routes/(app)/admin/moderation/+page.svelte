<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { addToast } from "$lib/toast.svelte.js";

	type Flag = {
		id: string;
		listingId: string;
		userId: string;
		reason: string;
		category: string;
		status: string;
		createdAt: string;
		listing: { id: string; name: string; slug: string } | null;
	};

	let flags = $state<Flag[]>([]);
	let loading = $state(true);
	let isAdmin = $state(false);

	async function checkAdmin() {
		try {
			const res = await fetch("/api/auth/me");
			const data = await res.json();
			if (data.user?.role !== "admin") {
				goto("/");
				return;
			}
			isAdmin = true;
		} catch {
			goto("/");
		}
	}

	async function loadFlags() {
		loading = true;
		try {
			const res = await fetch("/api/marketplace/flags");
			if (!res.ok) {
				if (res.status === 403 || res.status === 401) {
					goto("/");
					return;
				}
				throw new Error("Failed to load flags");
			}
			const data = await res.json();
			flags = data.flags;
		} catch {
			addToast({ type: "error", message: "Failed to load moderation queue" });
		} finally {
			loading = false;
		}
	}

	async function resolveFlag(listingId: string, flagId: string, action: "dismissed" | "removed") {
		try {
			const res = await fetch(`/api/marketplace/${listingId}/flags`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ flagId, action }),
			});
			if (!res.ok) throw new Error();
			flags = flags.filter((f) => f.id !== flagId);
			addToast({ type: "success", message: action === "dismissed" ? "Flag dismissed" : "Listing removed" });
		} catch {
			addToast({ type: "error", message: "Action failed" });
		}
	}

	async function deleteListing(listingId: string) {
		if (!confirm("Permanently delete this listing? This cannot be undone.")) return;
		try {
			const res = await fetch(`/api/marketplace/${listingId}/delete`, { method: "DELETE" });
			if (!res.ok) throw new Error();
			flags = flags.filter((f) => f.listingId !== listingId);
			addToast({ type: "success", message: "Listing permanently deleted" });
		} catch {
			addToast({ type: "error", message: "Delete failed" });
		}
	}

	const categoryColors: Record<string, string> = {
		spam: "bg-yellow-900/40 text-yellow-300",
		malicious: "bg-red-900/40 text-red-300",
		misleading: "bg-orange-900/40 text-orange-300",
		inappropriate: "bg-purple-900/40 text-purple-300",
		other: "bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]",
	};

	onMount(async () => {
		await checkAdmin();
		if (isAdmin) await loadFlags();
	});
</script>

<div class="space-y-6">
	<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Moderation Dashboard</h2>

	{#if loading}
		<p class="text-[var(--color-text-muted)]">Loading moderation queue...</p>
	{:else if flags.length === 0}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center">
			<p class="text-[var(--color-text-secondary)]">No pending flags. All clear!</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each flags as flag (flag.id)}
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<h3 class="truncate font-semibold text-[var(--color-text-primary)]">
									{flag.listing?.name ?? "Deleted listing"}
								</h3>
								<span class="shrink-0 rounded px-1.5 py-0.5 text-xs {categoryColors[flag.category] ?? categoryColors.other}">
									{flag.category}
								</span>
							</div>
							<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{flag.reason}</p>
							<p class="mt-1 text-xs text-[var(--color-text-muted)]">
								Reported {new Date(flag.createdAt).toLocaleDateString()}
							</p>
						</div>
						<div class="flex shrink-0 gap-2">
							<button
								onclick={() => resolveFlag(flag.listingId, flag.id, "dismissed")}
								class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
							>
								Dismiss
							</button>
							<button
								onclick={() => resolveFlag(flag.listingId, flag.id, "removed")}
								class="rounded-md bg-red-600/80 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-500"
							>
								Remove Listing
							</button>
							<button
								onclick={() => deleteListing(flag.listingId)}
								class="rounded-md border border-red-600 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-600 hover:text-white"
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
