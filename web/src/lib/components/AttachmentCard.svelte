<script lang="ts">
	import type { AttachmentSummary } from "$lib/api.js";
	import { lightbox } from "$lib/image-lightbox.svelte.js";
	import { progressiveImage } from "$lib/progressive-image.js";
	import {
		prettyBytes,
		iconForKind,
		attachmentUrl,
		attachmentDownloadUrl,
	} from "./attachment-card-logic.js";

	let { attachment }: { attachment: AttachmentSummary } = $props();

	let url = $derived(attachmentUrl(attachment.id));
	let downloadUrl = $derived(attachmentDownloadUrl(attachment.id));
	let imageFailed = $state(false);

	function openLightbox() {
		lightbox.show(url, attachment.filename, null);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			openLightbox();
		}
	}
</script>

{#if attachment.kind === "image" && !imageFailed}
	<button
		type="button"
		class="attachment-card attachment-image progressive-img-wrap"
		onclick={openLightbox}
		onkeydown={onKey}
		data-testid="attachment-card-image"
		aria-label={`Open ${attachment.filename}`}
	>
		<img
			class="progressive-img"
			src={url}
			alt={attachment.filename}
			loading="lazy"
			use:progressiveImage
			onerror={() => (imageFailed = true)}
		/>
	</button>
{:else if attachment.kind === "audio"}
	<div class="attachment-card attachment-audio" data-testid="attachment-card-audio">
		<audio
			controls
			preload="metadata"
			src={url}
			aria-label={attachment.filename}
		></audio>
	</div>
{:else}
	<div class="attachment-card attachment-file" data-testid="attachment-card-file">
		<span class="attachment-icon" aria-hidden="true">{iconForKind(attachment.kind)}</span>
		<div class="attachment-meta">
			<span class="attachment-filename" title={attachment.filename}>{attachment.filename}</span>
			<span class="attachment-size">{prettyBytes(attachment.sizeBytes)}</span>
		</div>
		<a
			class="attachment-download"
			href={downloadUrl}
			download={attachment.filename}
			data-testid="attachment-download"
			aria-label={`Download ${attachment.filename}`}
		>
			Download
		</a>
	</div>
{/if}

<style>
	.attachment-card {
		display: inline-flex;
		border-radius: 0.5rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface-primary);
		overflow: hidden;
	}
	.attachment-image {
		padding: 0;
		cursor: zoom-in;
		max-width: 18rem;
		max-height: 16rem;
		background: var(--color-surface-tertiary);
	}
	.attachment-image img {
		display: block;
		max-width: 100%;
		max-height: 16rem;
		width: auto;
		height: auto;
		object-fit: contain;
	}
	.attachment-file {
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 0.75rem;
		min-width: 14rem;
		max-width: 20rem;
	}
	.attachment-audio {
		align-items: center;
		padding: 0.375rem 0.5rem;
		max-width: 22rem;
	}
	.attachment-audio audio {
		display: block;
		width: 100%;
		min-width: 14rem;
	}
	.attachment-icon {
		font-size: 1.25rem;
		line-height: 1;
	}
	.attachment-meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.attachment-filename {
		font-size: 0.8125rem;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.attachment-size {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}
	.attachment-download {
		font-size: 0.75rem;
		color: var(--color-text-primary);
		text-decoration: none;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		border: 1px solid var(--color-border);
	}
	.attachment-download:hover {
		background: var(--color-surface-tertiary);
	}
</style>
