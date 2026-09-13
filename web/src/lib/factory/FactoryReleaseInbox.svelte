<script lang="ts">
	import { BellRing, Check, CircleAlert, CircleCheck, RefreshCw, X } from "lucide-svelte";
	import type { FactoryReleaseNotificationResource } from "@ezcorp/factory-sdk/types";
	import { FactoryApiClient, type FactoryReleaseNotificationApi } from "./client";

	let { projectId, api = new FactoryApiClient() }: { projectId: string; api?: FactoryReleaseNotificationApi } = $props();
	let items = $state<readonly FactoryReleaseNotificationResource[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(false);
	let deciding = $state("");
	let errorMessage = $state("");
	let requestVersion = 0;

	$effect(() => {
		const currentProject = projectId;
		const version = ++requestVersion;
		items = [];
		nextCursor = null;
		errorMessage = "";
		if (currentProject) void load(currentProject, null, version);
	});

	function merge(current: readonly FactoryReleaseNotificationResource[], incoming: readonly FactoryReleaseNotificationResource[]): readonly FactoryReleaseNotificationResource[] {
		const unique = new Map(current.map(item => [item.notificationId, item]));
		for (const item of incoming) unique.set(item.notificationId, item);
		return [...unique.values()].sort((left, right) => right.createdAtMs - left.createdAtMs || left.notificationId.localeCompare(right.notificationId));
	}

	async function load(currentProject = projectId, cursor: string | null = null, version = ++requestVersion): Promise<void> {
		if (!currentProject) return;
		loading = true;
		errorMessage = "";
		try {
			const page = await api.listReleaseNotifications(currentProject, { limit: 100, ...(cursor ? { cursor } : {}) });
			if (version !== requestVersion || currentProject !== projectId) return;
			items = merge(cursor ? items : [], page.items);
			nextCursor = page.nextCursor;
		} catch (error) {
			if (version === requestVersion) errorMessage = error instanceof Error ? error.message : "Release inbox is unavailable.";
		} finally {
			if (version === requestVersion) loading = false;
		}
	}

	async function decide(item: Extract<FactoryReleaseNotificationResource, { kind: "approval_requested" }>, decision: "approved" | "denied"): Promise<void> {
		deciding = item.approvalId;
		errorMessage = "";
		try {
			await api.decideReleaseApproval(projectId, item.approvalId, item.contextDigest, decision);
			items = items.filter(current => current.notificationId !== item.notificationId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The release decision failed.";
		} finally {
			deciding = "";
		}
	}

	async function decideCommand(item: Extract<FactoryReleaseNotificationResource, { kind: "command_approval_requested" }>, choice: string): Promise<void> {
		deciding = item.approvalId;
		errorMessage = "";
		try {
			await api.decideCommandApproval(projectId, item.runId, item.approvalId, item.contextDigest, choice);
			items = items.filter(current => current.notificationId !== item.notificationId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The approval decision failed.";
		} finally {
			deciding = "";
		}
	}
</script>

<section class="release-inbox" aria-labelledby="release-inbox-title" data-testid="factory-release-inbox">
	<header>
		<div class="title-mark"><BellRing size={18} /></div>
		<div>
			<p>Human review</p>
			<h2 id="release-inbox-title">Factory inbox</h2>
		</div>
		<span class="count" aria-label={`${items.length} factory notifications`}>{items.length}</span>
		<button class="refresh" aria-label="Refresh factory inbox" disabled={loading || !projectId} onclick={() => load()}><span class:spin={loading}><RefreshCw size={15} /></span></button>
	</header>

	{#if errorMessage}<div class="inbox-error" role="alert">{errorMessage}</div>{/if}
	{#if loading && items.length === 0}
		<p class="empty" aria-live="polite">Checking current release authority…</p>
	{:else if items.length === 0}
		<p class="empty">No factory actions need your attention.</p>
	{:else}
		<div class="items" aria-live="polite">
			{#each items as item (item.notificationId)}
				<article class:uncertain={item.kind === "release_uncertain"} class:settled={item.kind === "release_settled"}>
					<div class="kind-icon">
						{#if item.kind === "approval_requested" || item.kind === "command_approval_requested"}<BellRing size={16} />{:else if item.kind === "release_uncertain"}<CircleAlert size={17} />{:else}<CircleCheck size={17} />{/if}
					</div>
					<div class="copy">
						<strong>{item.kind === "command_approval_requested" ? "Factory approval requested" : item.kind === "approval_requested" ? "Release approval requested" : item.kind === "release_uncertain" ? "Release outcome uncertain" : "Release completed"}</strong>
						<code title={item.kind === "command_approval_requested" ? item.commandId : item.operationId}>{item.kind === "command_approval_requested" ? item.commandId : item.operationId}</code>
						{#if item.kind === "approval_requested"}
							<small>Review the exact candidate before this request expires.</small>
						{:else if item.kind === "command_approval_requested"}
							<small>Node {item.nodeInstanceId} · {JSON.stringify(item.context)}</small>
						{:else if item.kind === "release_uncertain"}
							<small>Generation {item.dispatchGeneration} · {item.outcomeCode}. Reconciliation is required.</small>
						{:else}
							<small>Generation {item.dispatchGeneration} · {item.outcomeCode}</small>
						{/if}
					</div>
					{#if item.kind === "approval_requested"}
						<div class="decision-actions">
							<button class="deny" disabled={deciding === item.approvalId} onclick={() => decide(item, "denied")}><X size={14} /> Deny</button>
							<button class="approve" disabled={deciding === item.approvalId} onclick={() => decide(item, "approved")}><Check size={14} /> Approve</button>
						</div>
					{:else if item.kind === "command_approval_requested"}
						<div class="decision-actions">
							{#each item.choices as choice}
								<button class="approve" disabled={deciding === item.approvalId} onclick={() => decideCommand(item, choice)}>{choice}</button>
							{/each}
						</div>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
	{#if nextCursor}<button class="load-more" disabled={loading} onclick={() => load(projectId, nextCursor)}>Load more</button>{/if}
</section>

<style>
	.release-inbox { border-bottom: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-surface-secondary) 82%, var(--color-accent) 3%); color: var(--color-text-primary); }
	header { display: flex; min-height: 58px; align-items: center; gap: 10px; padding: 8px 28px; }
	header p { margin: 0 0 2px; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
	header h2 { margin: 0; font-size: 15px; }
	.title-mark { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-border)); border-radius: 3px; color: var(--color-accent); }
	.count { display: grid; min-width: 22px; height: 22px; margin-left: auto; place-items: center; border-radius: 999px; background: var(--color-surface-elevated); color: var(--color-text-secondary); font: 700 10px var(--font-mono); }
	.refresh { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-secondary); }
	.refresh:focus-visible, button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	.refresh:disabled, button:disabled { opacity: .5; }
	.items { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 0 28px 14px; }
	article { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); gap: 10px; border: 1px solid var(--color-border); border-left: 3px solid var(--color-accent); border-radius: 3px; background: var(--color-surface-elevated); padding: 11px; }
	article.uncertain { border-left-color: var(--color-amber-500); }
	article.settled { border-left-color: var(--color-green-500); }
	.kind-icon { color: var(--color-accent); }
	.uncertain .kind-icon { color: var(--color-amber-600); }
	.settled .kind-icon { color: var(--color-green-600); }
	.copy { display: grid; min-width: 0; gap: 3px; }
	.copy strong { font-size: 12px; }
	.copy code { overflow: hidden; color: var(--color-text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
	.copy small { color: var(--color-text-secondary); font-size: 10px; line-height: 1.4; }
	.decision-actions { display: flex; grid-column: 1 / -1; justify-content: flex-end; gap: 6px; padding-top: 4px; }
	.decision-actions button, .load-more { display: inline-flex; min-height: 30px; align-items: center; gap: 4px; border-radius: 3px; padding: 5px 9px; font-size: 11px; font-weight: 700; }
	.deny { border: 1px solid var(--color-border-strong); background: transparent; color: var(--color-text-secondary); }
	.approve { border: 1px solid var(--color-accent); background: var(--color-accent); color: white; }
	.empty, .inbox-error { margin: 0; padding: 0 28px 14px; color: var(--color-text-muted); font-size: 11px; }
	.inbox-error { color: var(--color-red-700); }
	.load-more { margin: 0 28px 14px; border: 1px solid var(--color-border-strong); background: var(--color-surface-elevated); color: var(--color-text-secondary); }
	.spin { animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (max-width: 980px) { .items { grid-template-columns: 1fr; } }
	@media (max-width: 700px) { header, .items { padding-right: 16px; padding-left: 16px; } .empty, .inbox-error { padding-right: 16px; padding-left: 16px; } }
	@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
