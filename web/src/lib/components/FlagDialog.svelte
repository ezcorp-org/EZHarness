<script lang="ts">
	import { addToast } from "$lib/toast.svelte.js";

	const CATEGORIES = [
		{ value: "spam", label: "Spam" },
		{ value: "malicious", label: "Malicious" },
		{ value: "misleading", label: "Misleading" },
		{ value: "inappropriate", label: "Inappropriate" },
		{ value: "other", label: "Other" },
	] as const;

	let {
		listingId,
		open = false,
		onclose,
	}: {
		listingId: string;
		open: boolean;
		onclose: () => void;
	} = $props();

	let category = $state("spam");
	let reason = $state("");
	let submitting = $state(false);

	async function handleSubmit() {
		if (!reason.trim()) return;
		submitting = true;
		try {
			const res = await fetch(`/api/marketplace/${listingId}/flag`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: reason.trim(), category }),
			});
			if (res.status === 429) {
				addToast({ type: "warning", message: "You've reached the flag limit. Try again later." });
				onclose();
				return;
			}
			if (!res.ok) {
				const data = await res.json();
				addToast({ type: "error", message: data.error ?? "Failed to flag listing" });
				return;
			}
			addToast({ type: "success", message: "Listing flagged for review" });
			reason = "";
			category = "spam";
			onclose();
		} catch {
			addToast({ type: "error", message: "Failed to flag listing" });
		} finally {
			submitting = false;
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
		aria-label="Report listing"
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Report Listing</h3>
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

			<div class="space-y-4">
				<div>
					<label for="flag-category" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Category</label>
					<select
						id="flag-category"
						bind:value={category}
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-red-500 focus:outline-none"
					>
						{#each CATEGORIES as cat}
							<option value={cat.value}>{cat.label}</option>
						{/each}
					</select>
				</div>

				<div>
					<label for="flag-reason" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Reason</label>
					<textarea
						id="flag-reason"
						bind:value={reason}
						placeholder="Describe why you're reporting this listing..."
						rows="3"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-red-500 focus:outline-none"
					></textarea>
				</div>

				<div class="flex justify-end gap-2">
					<button
						onclick={onclose}
						class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
					>
						Cancel
					</button>
					<button
						onclick={handleSubmit}
						disabled={!reason.trim() || submitting}
						class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
					>
						{submitting ? "Submitting..." : "Submit Report"}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
