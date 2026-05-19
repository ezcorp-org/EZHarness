<script lang="ts">
	import { onMount } from "svelte";
	import {
		DISMISS_STORAGE_KEY,
		dismissValue,
		shouldShowBanner,
		type VersionInfo,
	} from "./UpdateBanner.helpers";

	let info = $state<VersionInfo | null>(null);
	let dismissed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch("/api/version");
			if (!res.ok) return;
			const data = (await res.json()) as VersionInfo;
			info = data;
			if (!shouldShowBanner(data, sessionStorage)) {
				dismissed = true;
			}
		} catch {
			// Silent — update check is best-effort.
		}
	});

	function dismiss() {
		if (info) {
			const val = dismissValue(info);
			if (val) sessionStorage.setItem(DISMISS_STORAGE_KEY, val);
		}
		dismissed = true;
	}
</script>

{#if info?.updateAvailable && !dismissed}
	<div class="update-banner" role="status">
		<span>
			Update available: <strong>{info.latest}</strong>
			<span class="current">(current: {info.current})</span>
		</span>
		<span class="actions">
			{#if info.releaseUrl}
				<a href={info.releaseUrl} target="_blank" rel="noopener noreferrer">Release notes</a>
			{/if}
			<button type="button" onclick={dismiss} aria-label="Dismiss">×</button>
		</span>
	</div>
{/if}

<style>
	.update-banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem 1rem;
		background: #1f3a5f;
		color: #fff;
		font-size: 0.875rem;
	}
	.current {
		opacity: 0.7;
		margin-left: 0.25rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.actions a {
		color: #fff;
		text-decoration: underline;
	}
	.actions button {
		background: transparent;
		border: none;
		color: #fff;
		font-size: 1.25rem;
		cursor: pointer;
		line-height: 1;
		padding: 0 0.25rem;
	}
	.actions button:hover {
		opacity: 0.7;
	}
</style>
