<script lang="ts">
	let {
		stagedFiles,
		onremove,
		error = null,
	}: {
		stagedFiles: File[];
		onremove?: (idx: number) => void;
		error?: string | null;
	} = $props();

	// Object URLs for staged image previews. Each effect run allocates new
	// URLs and closes over them in its cleanup, so the URLs are revoked when
	// the effect re-runs (or the component unmounts).
	let stagedPreviews = $state<Array<string | null>>([]);
	$effect(() => {
		const next = stagedFiles.map((f) =>
			f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
		);
		stagedPreviews = next;
		return () => {
			for (const url of next) if (url) URL.revokeObjectURL(url);
		};
	});
</script>

{#if stagedFiles.length > 0 || error}
	<div class="attachment-row" data-testid="attachment-tray">
		{#each stagedFiles as file, i (file.name + i)}
			{#if stagedPreviews[i]}
				<span class="attachment-thumb" data-testid="attachment-chip" title={file.name}>
					<img src={stagedPreviews[i]!} alt={file.name} />
					<button
						type="button"
						class="attachment-thumb-remove"
						aria-label={`Remove ${file.name}`}
						onclick={() => onremove?.(i)}
					>×</button>
				</span>
			{:else}
				<span class="attachment-chip" data-testid="attachment-chip">
					<span class="attachment-chip-name" title={file.name}>{file.name}</span>
					<button
						type="button"
						class="attachment-chip-remove"
						aria-label={`Remove ${file.name}`}
						onclick={() => onremove?.(i)}
					>×</button>
				</span>
			{/if}
		{/each}
		{#if error}
			<span class="attachment-error" data-testid="attachment-error" role="status">{error}</span>
		{/if}
	</div>
{/if}

<style>
	.attachment-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		margin-bottom: 4px;
	}
	.attachment-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px 2px 8px;
		border-radius: 10px;
		background: var(--color-surface-secondary);
		border: 1px solid var(--color-border);
		font-size: 11px;
		color: var(--color-text-secondary);
		max-width: 220px;
	}
	.attachment-chip-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.attachment-chip-remove {
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		padding: 0 4px;
		line-height: 1;
		font-size: 14px;
	}
	.attachment-chip-remove:hover {
		color: var(--color-text-primary);
	}
	.attachment-thumb {
		position: relative;
		display: inline-block;
		width: 56px;
		height: 56px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
	}
	.attachment-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.attachment-thumb-remove {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 18px;
		height: 18px;
		padding: 0;
		line-height: 1;
		font-size: 12px;
		border-radius: 50%;
		border: none;
		background: rgba(0, 0, 0, 0.6);
		color: #fff;
		cursor: pointer;
	}
	.attachment-thumb-remove:hover {
		background: rgba(0, 0, 0, 0.85);
	}
	.attachment-error {
		font-size: 11px;
		color: #f59e0b;
	}
</style>
