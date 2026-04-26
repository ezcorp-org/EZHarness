<script lang="ts">
	import { publishToMarketplace } from "$lib/api.js";

	let {
		agentConfigId,
		existingVersion = null,
		open = false,
		onclose,
		onpublish,
	}: {
		agentConfigId: string;
		existingVersion?: string | null;
		open?: boolean;
		onclose: () => void;
		onpublish: (listing: unknown) => void;
	} = $props();

	let version = $state("");
	let changelog = $state("");
	let tagsInput = $state("");
	let error = $state("");
	let submitting = $state(false);

	function suggestNextVersion(current: string): string {
		const parts = current.split(".").map(Number);
		if (parts.length === 3) {
			parts[2] += 1;
			return parts.join(".");
		}
		return "1.0.1";
	}

	$effect(() => {
		if (open) {
			version = existingVersion ? suggestNextVersion(existingVersion) : "1.0.0";
			changelog = "";
			tagsInput = "";
			error = "";
		}
	});

	async function handleSubmit() {
		if (!version.trim()) {
			error = "Version is required";
			return;
		}
		if (!/^\d+\.\d+\.\d+$/.test(version.trim())) {
			error = "Version must be semver (e.g. 1.0.0)";
			return;
		}

		submitting = true;
		error = "";
		try {
			const tags = tagsInput
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			const result = await publishToMarketplace(agentConfigId, {
				version: version.trim(),
				changelog: changelog.trim() || undefined,
				tags: tags.length > 0 ? tags : undefined,
			});
			onpublish(result);
			onclose();
		} catch (e) {
			error = e instanceof Error ? e.message : "Publish failed";
		} finally {
			submitting = false;
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onclick={onclose}
		onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="publish-dialog-title"
		tabindex={-1}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl"
			onclick={(e) => e.stopPropagation()}
		>
			<h2 id="publish-dialog-title" class="mb-4 text-lg font-bold text-[var(--color-text-primary)]">
				{existingVersion ? "Publish Update" : "Publish to Marketplace"}
			</h2>

			<div class="space-y-4">
				<div>
					<label for="pub-version" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">
						Version
					</label>
					<input
						id="pub-version"
						type="text"
						bind:value={version}
						placeholder="1.0.0"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>

				{#if existingVersion}
					<div>
						<label for="pub-changelog" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">
							Changelog
						</label>
						<textarea
							id="pub-changelog"
							bind:value={changelog}
							placeholder="What changed in this version?"
							rows="3"
							class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						></textarea>
					</div>
				{/if}

				<div>
					<label for="pub-tags" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">
						Tags (comma-separated)
					</label>
					<input
						id="pub-tags"
						type="text"
						bind:value={tagsInput}
						placeholder="coding, productivity, automation"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
				</div>

				{#if error}
					<p class="text-sm text-red-400">{error}</p>
				{/if}

				<div class="flex justify-end gap-3">
					<button
						onclick={onclose}
						class="rounded-md bg-[var(--color-surface-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
					>
						Cancel
					</button>
					<button
						onclick={handleSubmit}
						disabled={submitting}
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
					>
						{submitting ? "Publishing..." : "Publish"}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
