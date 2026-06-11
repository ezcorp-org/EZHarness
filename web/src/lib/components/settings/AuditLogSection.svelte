<script lang="ts">
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import MobileCardStack from "$lib/components/MobileCardStack.svelte";

	type AuditLogEntry = { id: string; userId: string | null; action: string; target: string | null; metadata: Record<string, unknown> | null; createdAt: string };

	let auditEntries = $state<AuditLogEntry[]>([]);
	let loadingAudit = $state(true);
	let auditOffset = $state(0);
	let auditFilter = $state<string>("");
	let hasMoreAudit = $state(false);

	// MobileCardStack data for audit log
	let auditRows = $derived(
		auditEntries.map((e) => ({
			id: e.id,
			time: new Date(e.createdAt).toLocaleString(),
			action: e.action,
			target: e.target ?? "-",
			details: e.metadata ? JSON.stringify(e.metadata) : "-",
		}))
	);
	const auditColumns = [
		{ key: "time", label: "Time" },
		{ key: "action", label: "Action" },
		{ key: "target", label: "Target" },
		{ key: "details", label: "Details" },
	];

	async function loadAuditLog(reset = false) {
		if (reset) {
			auditOffset = 0;
			auditEntries = [];
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

	$effect(() => {
		loadAuditLog(true);
	});
</script>

<SettingsSection
	id="audit"
	title="Audit Log"
	description="View authentication and sharing events."
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
						<th class="pb-2 pr-3">Time</th>
						<th class="pb-2 pr-3">Action</th>
						<th class="pb-2 pr-3">Target</th>
						<th class="pb-2">Details</th>
					</tr>
				</thead>
				<tbody>
					{#each auditEntries as entry}
						<tr class="border-b border-[var(--color-border)]">
							<td class="py-2 pr-3 text-[var(--color-text-secondary)] whitespace-nowrap">
								{new Date(entry.createdAt).toLocaleString()}
							</td>
							<td class="py-2 pr-3">
								<span class="rounded-full px-2 py-0.5 text-xs font-medium
									{entry.action.startsWith('auth:') ? 'bg-blue-900 text-blue-300' :
									entry.action.startsWith('user:') ? 'bg-purple-900 text-purple-300' :
									entry.action.startsWith('agent:') ? 'bg-green-900 text-green-300' :
									'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">
									{entry.action}
								</span>
							</td>
							<td class="py-2 pr-3 text-[var(--color-text-secondary)] truncate max-w-[120px]">{entry.target ?? "-"}</td>
							<td class="py-2 text-[var(--color-text-secondary)] truncate max-w-[200px]">
								{entry.metadata ? JSON.stringify(entry.metadata) : "-"}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="md:hidden">
			<MobileCardStack columns={auditColumns} rows={auditRows} keyField="id" />
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
