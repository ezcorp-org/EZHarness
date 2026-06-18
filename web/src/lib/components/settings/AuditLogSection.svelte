<script lang="ts">
	import { onMount } from "svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import { groupConsecutive, relativeTime, prettyMetadata, type AuditViewRow } from "$lib/audit-log-view.js";

	let auditEntries = $state<AuditViewRow[]>([]);
	let loadingAudit = $state(true);
	let auditOffset = $state(0);
	let auditFilter = $state<string>("");
	let hasMoreAudit = $state(false);
	let expandedGroupId = $state<string | null>(null);

	// Live-ticking clock for the relative-time labels (locked decision 4:
	// ticking is a component concern). `now` re-flows through every
	// relativeTime(..., now) call below; the pure relativeTime helper is
	// untouched. Refreshes on a 60s interval, cleaned up on destroy.
	const TICK_MS = 60_000;
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, TICK_MS);
		return () => clearInterval(id);
	});

	// Locked decision 7 — consecutive rows with identical action + actor
	// collapse into one ×N row with an expander.
	const auditGroups = $derived(groupConsecutive(auditEntries));

	function actionPillClass(action: string): string {
		if (action.startsWith("auth:")) return "bg-blue-900 text-blue-300";
		if (action.startsWith("user:")) return "bg-purple-900 text-purple-300";
		if (action.startsWith("agent:")) return "bg-green-900 text-green-300";
		return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]";
	}

	function toggleGroup(id: string) {
		expandedGroupId = expandedGroupId === id ? null : id;
	}

	async function loadAuditLog(reset = false) {
		if (reset) {
			auditOffset = 0;
			auditEntries = [];
			expandedGroupId = null;
		}
		loadingAudit = true;
		try {
			const params = new URLSearchParams({ limit: "50", offset: String(auditOffset) });
			if (auditFilter) params.set("action", auditFilter);
			const res = await fetch(`/api/audit-log?${params}`);
			if (res.ok) {
				const data = await res.json();
				if (reset) {
					auditEntries = data.entries;
				} else {
					auditEntries = [...auditEntries, ...data.entries];
				}
				hasMoreAudit = data.entries.length === 50;
				auditOffset += data.entries.length;
			}
		} catch { /* silent */ }
		loadingAudit = false;
	}

	// onMount, NOT $effect: loadAuditLog synchronously reads
	// auditOffset/auditFilter and later mutates auditOffset — inside an
	// $effect that read/write pair self-retriggers into an infinite
	// refetch loop.
	onMount(() => {
		loadAuditLog(true);
	});
</script>

<SettingsSection
	id="audit"
	title="Audit Log"
	description="View authentication and sharing events. Click a row for full details."
>
	<!-- Filter -->
	<div class="mb-4">
		<select
			bind:value={auditFilter}
			onchange={() => loadAuditLog(true)}
			aria-label="Filter audit events"
			class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
		>
			<option value="">All events</option>
			<option value="auth:login">Login</option>
			<option value="auth:failed_login">Failed login</option>
			<option value="user:registered">Registration</option>
			<option value="user:invited">Invite created</option>
			<option value="user:deactivated">User deactivated</option>
			<option value="agent:shared">Agent shared</option>
			<option value="agent:unshared">Agent unshared</option>
			<option value="ext:capability-policy-write">Capability policy</option>
		</select>
	</div>

	{#if loadingAudit && auditEntries.length === 0}
		<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
	{:else if auditEntries.length === 0}
		<p class="text-sm text-[var(--color-text-secondary)]">No audit events found.</p>
	{:else}
		<div class="hidden md:block overflow-x-auto">
			<table class="w-full text-xs">
				<thead>
					<tr class="border-b border-[var(--color-border)] text-left text-[var(--color-text-secondary)]">
						<th class="pb-2 pr-3 w-4"><span class="sr-only">Expand</span></th>
						<th class="pb-2 pr-3">Time</th>
						<th class="pb-2 pr-3">Action</th>
						<th class="pb-2 pr-3">Target</th>
						<th class="pb-2">Details</th>
					</tr>
				</thead>
				<tbody>
					{#each auditGroups as group (group.id)}
						{@const expanded = expandedGroupId === group.id}
						<tr
							class="cursor-pointer border-b border-[var(--color-border)] hover:bg-[var(--color-surface)] transition-colors"
							data-testid="audit-group-{group.id}"
							onclick={() => toggleGroup(group.id)}
						>
							<td class="py-2 pr-1">
								<button
									type="button"
									aria-expanded={expanded}
									aria-label="{expanded ? 'Collapse' : 'Expand'} audit entry details"
									class="rounded p-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
								>
									<svg class="h-3.5 w-3.5 transition-transform duration-200 {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
									</svg>
								</button>
							</td>
							<td
								class="py-2 pr-3 text-[var(--color-text-secondary)] whitespace-nowrap"
								title={new Date(group.first.createdAt).toLocaleString()}
							>
								{relativeTime(group.first.createdAt, now)}
							</td>
							<td class="py-2 pr-3 whitespace-nowrap">
								<span class="rounded-full px-2 py-0.5 text-xs font-medium {actionPillClass(group.first.action)}">
									{group.first.action}
								</span>
								{#if group.count > 1}
									<span class="ml-1 rounded-full bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]" data-testid="audit-group-count">×{group.count}</span>
								{/if}
							</td>
							<td class="py-2 pr-3 text-[var(--color-text-secondary)] truncate max-w-[120px]">{group.first.target ?? "-"}</td>
							<td class="py-2 text-[var(--color-text-secondary)] truncate max-w-[200px]">
								{group.first.metadata ? JSON.stringify(group.first.metadata) : "-"}
							</td>
						</tr>
						{#if expanded}
							<tr class="border-b border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="audit-group-details">
								<td></td>
								<td colspan="4" class="py-3 pr-3">
									<div class="space-y-3">
										{#each group.rows as entry (entry.id)}
											<div>
												<p class="mb-1 text-[var(--color-text-muted)]">
													<span title={new Date(entry.createdAt).toLocaleString()}>{relativeTime(entry.createdAt, now)}</span>
													— {new Date(entry.createdAt).toLocaleString()}
													{#if entry.target}· {entry.target}{/if}
												</p>
												<pre class="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-[11px] leading-snug text-[var(--color-text-primary)]">{prettyMetadata(entry.metadata)}</pre>
											</div>
										{/each}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		<!--
			Mobile: expandable audit cards (parity with the desktop rows).
			Implemented inline rather than via MobileCardStack so a card can
			own its own expander + pretty-printed JSON per group member
			(locked decision: do not bloat the shared MobileCardStack).
		-->
		<div class="md:hidden space-y-2">
			{#each auditGroups as group (group.id)}
				{@const expanded = expandedGroupId === group.id}
				<div class="rounded-lg border border-[var(--color-border)]">
					<button
						type="button"
						data-testid="audit-card-{group.id}"
						aria-expanded={expanded}
						aria-label="{expanded ? 'Collapse' : 'Expand'} audit entry details"
						onclick={() => toggleGroup(group.id)}
						class="flex w-full items-start gap-2 p-3 text-left"
					>
						<svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)] transition-transform duration-200 {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
						</svg>
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex items-center gap-1.5 text-xs">
								<span class="rounded-full px-2 py-0.5 font-medium {actionPillClass(group.first.action)}">{group.first.action}</span>
								{#if group.count > 1}
									<span class="rounded-full bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]" data-testid="audit-card-count-{group.id}">×{group.count}</span>
								{/if}
							</div>
							<p class="text-[11px] text-[var(--color-text-secondary)]">
								<span title={new Date(group.first.createdAt).toLocaleString()}>{relativeTime(group.first.createdAt, now)}</span>
								{#if group.first.target}· {group.first.target}{/if}
							</p>
						</div>
					</button>
					{#if expanded}
						<div class="border-t border-[var(--color-border)] px-3 pb-3 pt-2 space-y-3" data-testid="audit-card-details-{group.id}">
							{#each group.rows as entry (entry.id)}
								<div>
									<p class="mb-1 text-[11px] text-[var(--color-text-muted)]">
										<span title={new Date(entry.createdAt).toLocaleString()}>{relativeTime(entry.createdAt, now)}</span>
										— {new Date(entry.createdAt).toLocaleString()}
									</p>
									<pre class="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-[11px] leading-snug text-[var(--color-text-primary)]">{prettyMetadata(entry.metadata)}</pre>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if hasMoreAudit}
			<button
				onclick={() => loadAuditLog()}
				disabled={loadingAudit}
				class="mt-3 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50 transition-colors"
			>
				{loadingAudit ? "Loading..." : "Load more"}
			</button>
		{/if}
	{/if}
</SettingsSection>
