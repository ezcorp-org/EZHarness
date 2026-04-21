<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import MobileCardStack from "$lib/components/MobileCardStack.svelte";

	type AnalyticsData = {
		chatActivity: { date: string; messageCount: number; conversationCount: number }[];
		modelUsage: { model: string; provider: string; count: number }[];
		agentStats: { name: string; conversationCount: number }[];
		extensionStats: { name: string; installCount: number }[];
		userStats: { totalUsers: number; activeUsers30d: number; signupsLast30d: { date: string; count: number }[] };
	};

	type SystemData = {
		health: { dbSizeBytes: number; uptimeSeconds: number; tableRowCounts: Record<string, number> };
		activityFeed: { id: string; action: string; target?: string; metadata?: object; createdAt: string; userName: string; userEmail: string }[];
		errorSummary: { totalErrors: number; errorRate: { date: string; count: number }[]; recentErrors: { id: string; level: string; message: string; createdAt: string }[] };
	};

	let activeTab = $state<"overview" | "usage" | "activity" | "system">("overview");
	let analyticsData = $state<AnalyticsData | null>(null);
	let systemData = $state<SystemData | null>(null);
	let lastUpdated = $state<Date | null>(null);
	let secondsAgo = $state(0);
	let isAdmin = $state(false);
	let loading = $state(true);

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

	async function fetchAnalytics() {
		const res = await fetch("/api/admin/analytics?days=30");
		if (res.ok) analyticsData = await res.json();
	}

	async function fetchSystem() {
		const res = await fetch("/api/admin/system");
		if (res.ok) systemData = await res.json();
	}

	async function refreshAll() {
		await Promise.all([fetchAnalytics(), fetchSystem()]);
		lastUpdated = new Date();
		loading = false;
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function formatUptime(seconds: number): string {
		const d = Math.floor(seconds / 86400);
		const h = Math.floor((seconds % 86400) / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const parts: string[] = [];
		if (d > 0) parts.push(`${d}d`);
		if (h > 0) parts.push(`${h}h`);
		parts.push(`${m}m`);
		return parts.join(" ");
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function shortDate(dateStr: string): string {
		const d = new Date(dateStr);
		return `${d.getMonth() + 1}/${d.getDate()}`;
	}

	function actionColor(action: string): string {
		if (action.includes("login") || action.includes("signup")) return "var(--color-success, #22c55e)";
		if (action.includes("error") || action.includes("delete")) return "var(--color-error, #ef4444)";
		if (action.includes("create") || action.includes("install")) return "var(--color-info, #3b82f6)";
		return "var(--color-text-muted)";
	}

	onMount(async () => {
		await checkAdmin();
		if (!isAdmin) return;

		await refreshAll();

		const refreshTimer = setInterval(() => {
			if (!document.hidden) refreshAll();
		}, 30_000);

		const tickTimer = setInterval(() => {
			if (lastUpdated) {
				secondsAgo = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
			}
		}, 1_000);

		const handleVisibility = () => {
			if (!document.hidden) refreshAll();
		};
		document.addEventListener("visibilitychange", handleVisibility);

		return () => {
			clearInterval(refreshTimer);
			clearInterval(tickTimer);
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	});

	// Derived stats for overview tab
	let totalUsers = $derived(analyticsData?.userStats.totalUsers ?? 0);
	let totalConversations = $derived(
		systemData?.health.tableRowCounts["conversations"] ?? 0
	);
	let totalMessages = $derived(
		systemData?.health.tableRowCounts["messages"] ?? 0
	);
	let activeAgents = $derived(
		systemData?.health.tableRowCounts["agents"] ?? 0
	);

	// Usage tab: max message count for bar scaling
	let maxMessageCount = $derived(
		analyticsData?.chatActivity.reduce((max, d) => Math.max(max, d.messageCount), 1) ?? 1
	);
	let maxModelCount = $derived(
		analyticsData?.modelUsage.reduce((max, d) => Math.max(max, d.count), 1) ?? 1
	);
	let topAgents = $derived(
		(analyticsData?.agentStats ?? []).slice(0, 10)
	);
	let maxAgentCount = $derived(
		topAgents.reduce((max, d) => Math.max(max, d.conversationCount), 1)
	);

	// System tab: max error rate for bar scaling
	let maxErrorRate = $derived(
		systemData?.errorSummary.errorRate.reduce((max, d) => Math.max(max, d.count), 1) ?? 1
	);

	// MobileCardStack data for resource counts
	let resourceRows = $derived(
		Object.entries(systemData?.health.tableRowCounts ?? {}).map(([table, count]) => ({
			id: table,
			name: table,
			count: (count as number).toLocaleString(),
		}))
	);
	const resourceColumns = [
		{ key: "name", label: "Resource" },
		{ key: "count", label: "Count" },
	];

	// MobileCardStack data for recent errors
	let errorRows = $derived(
		(systemData?.errorSummary.recentErrors ?? []).map((err) => ({
			id: err.id,
			level: err.level,
			message: err.message,
			time: formatDate(err.createdAt),
		}))
	);
	const errorColumns = [
		{ key: "level", label: "Level" },
		{ key: "message", label: "Message" },
		{ key: "time", label: "Time" },
	];

	const tabs = [
		{ id: "overview" as const, label: "Overview" },
		{ id: "usage" as const, label: "Usage" },
		{ id: "activity" as const, label: "Activity" },
		{ id: "system" as const, label: "System" },
	];
</script>

{#if !isAdmin}
	<div></div>
{:else}
	<div class="dashboard">
		<div class="dashboard-header">
			<h2 class="dashboard-title">Admin Dashboard</h2>
			{#if lastUpdated}
				<span class="last-updated">Updated {secondsAgo}s ago</span>
			{/if}
		</div>

		<!-- Tab bar -->
		<div class="tab-bar">
			{#each tabs as tab}
				<button
					class="tab-btn {activeTab === tab.id ? 'active' : ''}"
					onclick={() => (activeTab = tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		<!-- Tab content -->
		<div class="tab-content">
			{#if loading}
				<SkeletonLoader type="card-grid" count={4} />

			{:else if activeTab === "overview"}
				<div class="stat-grid">
					<div class="stat-card">
						<div class="stat-value">{totalUsers.toLocaleString()}</div>
						<div class="stat-label">Total Users</div>
						{#if analyticsData?.userStats.activeUsers30d}
							<div class="stat-trend">{analyticsData.userStats.activeUsers30d} active (30d)</div>
						{/if}
					</div>
					<div class="stat-card">
						<div class="stat-value">{totalConversations.toLocaleString()}</div>
						<div class="stat-label">Total Conversations</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{totalMessages.toLocaleString()}</div>
						<div class="stat-label">Total Messages</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{activeAgents.toLocaleString()}</div>
						<div class="stat-label">Active Agents</div>
					</div>
				</div>

			{:else if activeTab === "usage"}
				<!-- Chat Activity Bar Chart -->
				<div class="section">
					<h3 class="section-title">Chat Activity (Last 30 Days)</h3>
					{#if analyticsData?.chatActivity.length}
						<div class="bar-chart">
							{#each analyticsData.chatActivity as day}
								<div class="bar-col" title="{day.date}: {day.messageCount} messages, {day.conversationCount} conversations">
									<div class="bar" style="height: {(day.messageCount / maxMessageCount) * 100}%"></div>
									<span class="bar-label">{shortDate(day.date)}</span>
								</div>
							{/each}
						</div>
					{:else}
						<p class="empty-text">No chat activity in this period.</p>
					{/if}
				</div>

				<!-- Model Usage -->
				<div class="section">
					<h3 class="section-title">Model Usage</h3>
					{#if analyticsData?.modelUsage.length}
						<div class="h-bar-list">
							{#each analyticsData.modelUsage as model}
								<div class="h-bar-row">
									<span class="h-bar-label">{model.model} <span class="text-muted">({model.provider})</span></span>
									<div class="h-bar-track">
										<div class="h-bar-fill" style="width: {(model.count / maxModelCount) * 100}%"></div>
									</div>
									<span class="h-bar-value">{model.count.toLocaleString()}</span>
								</div>
							{/each}
						</div>
					{:else}
						<p class="empty-text">No model usage data.</p>
					{/if}
				</div>

				<!-- Agent Stats -->
				<div class="section">
					<h3 class="section-title">Top Agents by Conversations</h3>
					{#if topAgents.length}
						<div class="h-bar-list">
							{#each topAgents as agent}
								<div class="h-bar-row">
									<span class="h-bar-label">{agent.name}</span>
									<div class="h-bar-track">
										<div class="h-bar-fill agent" style="width: {(agent.conversationCount / maxAgentCount) * 100}%"></div>
									</div>
									<span class="h-bar-value">{agent.conversationCount.toLocaleString()}</span>
								</div>
							{/each}
						</div>
					{:else}
						<p class="empty-text">No agent data.</p>
					{/if}
				</div>

			{:else if activeTab === "activity"}
				<div class="section">
					<h3 class="section-title">Recent Activity</h3>
					{#if systemData?.activityFeed.length}
						<div class="activity-list">
							{#each systemData.activityFeed as entry}
								<div class="activity-entry">
									<span class="activity-dot" style="background: {actionColor(entry.action)}"></span>
									<div class="activity-body">
										<div class="activity-main">
											<span class="activity-action">{entry.action}</span>
											{#if entry.target}
												<span class="text-muted"> on {entry.target}</span>
											{/if}
										</div>
										<div class="activity-meta">
											{entry.userName} ({entry.userEmail}) -- {formatDate(entry.createdAt)}
										</div>
									</div>
								</div>
							{/each}
						</div>
					{:else}
						<p class="empty-text">No recent activity.</p>
					{/if}
				</div>

			{:else if activeTab === "system"}
				<!-- Health Cards -->
				<div class="stat-grid">
					<div class="stat-card">
						<div class="stat-value">{formatBytes(systemData?.health.dbSizeBytes ?? 0)}</div>
						<div class="stat-label">Database Size</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatUptime(systemData?.health.uptimeSeconds ?? 0)}</div>
						<div class="stat-label">Uptime</div>
					</div>
				</div>

				<!-- Table Row Counts -->
				<div class="section">
					<h3 class="section-title">Resource Counts</h3>
					{#if systemData?.health.tableRowCounts}
						<div class="hidden md:block">
							<div class="resource-grid">
								{#each Object.entries(systemData.health.tableRowCounts) as [table, count]}
									<div class="resource-item">
										<span class="resource-name">{table}</span>
										<span class="resource-count">{(count as number).toLocaleString()}</span>
									</div>
								{/each}
							</div>
						</div>
						<div class="md:hidden">
							<MobileCardStack columns={resourceColumns} rows={resourceRows} keyField="id" />
						</div>
					{/if}
				</div>

				<!-- Error Summary -->
				<div class="section">
					<h3 class="section-title">Errors (Last 7 Days)</h3>
					<div class="stat-inline">
						<strong>{systemData?.errorSummary.totalErrors ?? 0}</strong> total errors
					</div>

					{#if systemData?.errorSummary.errorRate.length}
						<div class="bar-chart compact">
							{#each systemData.errorSummary.errorRate as day}
								<div class="bar-col" title="{day.date}: {day.count} errors">
									<div class="bar error" style="height: {(day.count / maxErrorRate) * 100}%"></div>
									<span class="bar-label">{shortDate(day.date)}</span>
								</div>
							{/each}
						</div>
					{/if}

					{#if systemData?.errorSummary.recentErrors.length}
						<h4 class="subsection-title">Recent Errors</h4>
						<div class="hidden md:block">
							<div class="error-list">
								{#each systemData.errorSummary.recentErrors as err}
									<div class="error-entry">
										<span class="error-level {err.level}">{err.level}</span>
										<span class="error-message">{err.message}</span>
										<span class="error-time">{formatDate(err.createdAt)}</span>
									</div>
								{/each}
							</div>
						</div>
						<div class="md:hidden">
							<MobileCardStack columns={errorColumns} rows={errorRows} keyField="id" />
						</div>
					{:else}
						<p class="empty-text">No recent errors.</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.dashboard {
		max-width: 1200px;
	}
	.dashboard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.5rem;
	}
	.dashboard-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text-primary);
	}
	.last-updated {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	/* Tab bar */
	.tab-bar {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: 1.5rem;
	}
	.tab-btn {
		padding: 0.75rem 1rem;
		min-height: 44px;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-muted);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}
	.tab-btn:hover {
		color: var(--color-text-primary);
	}
	.tab-btn.active {
		color: var(--color-text-primary);
		border-bottom-color: var(--color-primary, #3b82f6);
	}

	/* Stat cards grid */
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	@media (min-width: 768px) {
		.stat-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}
	.stat-card {
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		padding: 1.25rem;
		background: var(--color-surface-secondary);
	}
	.stat-value {
		font-size: 1.75rem;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
	}
	.stat-label {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
	}
	.stat-trend {
		font-size: 0.75rem;
		color: var(--color-success, #22c55e);
		margin-top: 0.375rem;
	}
	.stat-inline {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		margin-bottom: 1rem;
	}

	/* Sections */
	.section {
		margin-bottom: 2rem;
	}
	.section-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin-bottom: 0.75rem;
	}
	.subsection-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 1rem 0 0.5rem;
	}

	/* Vertical bar chart */
	.bar-chart {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 160px;
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 1.5rem;
		overflow-x: auto;
	}
	.bar-chart.compact {
		height: 100px;
	}
	.bar-col {
		flex: 1;
		min-width: 12px;
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		justify-content: flex-end;
		position: relative;
	}
	.bar {
		width: 100%;
		max-width: 24px;
		background: var(--color-primary, #3b82f6);
		border-radius: 2px 2px 0 0;
		min-height: 2px;
		transition: height 0.3s ease;
	}
	.bar.error {
		background: var(--color-error, #ef4444);
	}
	.bar-label {
		font-size: 0.5625rem;
		color: var(--color-text-muted);
		position: absolute;
		bottom: -1.25rem;
		white-space: nowrap;
	}
	/* Show every other label to avoid crowding */
	.bar-col:nth-child(odd) .bar-label {
		display: none;
	}

	/* Horizontal bar list */
	.h-bar-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.h-bar-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.h-bar-label {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		min-width: 80px;
		max-width: 140px;
		flex-shrink: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (min-width: 768px) {
		.h-bar-label {
			min-width: 140px;
			max-width: none;
		}
	}
	.h-bar-track {
		flex: 1;
		height: 0.5rem;
		background: var(--color-surface-tertiary);
		border-radius: 0.25rem;
		overflow: hidden;
	}
	.h-bar-fill {
		height: 100%;
		background: var(--color-primary, #3b82f6);
		border-radius: 0.25rem;
		transition: width 0.3s ease;
	}
	.h-bar-fill.agent {
		background: var(--color-info, #6366f1);
	}
	.h-bar-value {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		min-width: 3rem;
		text-align: right;
	}

	/* Activity feed */
	.activity-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.activity-entry {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--color-border);
	}
	.activity-entry:last-child {
		border-bottom: none;
	}
	.activity-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		margin-top: 0.375rem;
		flex-shrink: 0;
	}
	.activity-body {
		flex: 1;
		min-width: 0;
	}
	.activity-main {
		font-size: 0.8125rem;
		color: var(--color-text-primary);
	}
	.activity-action {
		font-weight: 500;
	}
	.activity-meta {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin-top: 0.125rem;
	}

	/* Resource grid */
	.resource-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.5rem;
	}
	@media (min-width: 768px) {
		.resource-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	.resource-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		background: var(--color-surface-secondary);
	}
	.resource-name {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-transform: capitalize;
	}
	.resource-count {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	/* Error list */
	.error-list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.error-entry {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.8125rem;
		padding: 0.375rem 0;
		border-bottom: 1px solid var(--color-border);
	}
	.error-entry:last-child {
		border-bottom: none;
	}
	.error-level {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		flex-shrink: 0;
	}
	.error-level.error {
		background: rgba(239, 68, 68, 0.15);
		color: #ef4444;
	}
	.error-level.warn {
		background: rgba(234, 179, 8, 0.15);
		color: #eab308;
	}
	.error-level.fatal {
		background: rgba(239, 68, 68, 0.25);
		color: #dc2626;
	}
	.error-message {
		color: var(--color-text-secondary);
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.error-time {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	/* Utilities */
	.text-muted {
		color: var(--color-text-muted);
	}
	.empty-text {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		font-style: italic;
	}
</style>
