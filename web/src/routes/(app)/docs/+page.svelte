<script lang="ts">
	import { onMount } from "svelte";

	interface RouteEntry {
		method: string;
		path: string;
		description: string;
		category: string;
		responseDescription?: string;
		requestJsonSchema?: {
			type?: string;
			properties?: Record<string, { type?: string; description?: string; enum?: string[]; format?: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; items?: { type?: string } }>;
			required?: string[];
		};
	}

	let routes = $state<RouteEntry[]>([]);
	let loading = $state(true);
	let error = $state("");
	let activeCategory = $state("");

	const methodColors: Record<string, string> = {
		GET: "bg-green-600",
		POST: "bg-blue-600",
		PUT: "bg-amber-600",
		PATCH: "bg-orange-600",
		DELETE: "bg-red-600",
	};

	const categoryLabels: Record<string, string> = {
		auth: "Authentication",
		account: "Account",
		conversations: "Conversations",
		agents: "Agents & Configs",
		extensions: "Extensions",
		marketplace: "Marketplace",
		"knowledge-base": "Knowledge Base",
		memories: "Memories",
		projects: "Projects",
		settings: "Settings",
		providers: "Providers & Models",
		users: "Users",
		teams: "Teams",
		workflows: "Workflows",
		tools: "Tools",
		runs: "Runs",
		observability: "Observability",
		mentions: "Mentions",
		system: "System",
		admin: "Admin",
	};

	let grouped = $derived(
		routes.reduce<Record<string, RouteEntry[]>>((acc, route) => {
			(acc[route.category] ??= []).push(route);
			return acc;
		}, {})
	);

	let categoryOrder = $derived(
		Object.keys(categoryLabels).filter((k) => grouped[k]?.length)
	);

	function getSchemaProperties(schema: RouteEntry["requestJsonSchema"]) {
		if (!schema?.properties) return [];
		const required = new Set(schema.required ?? []);
		return Object.entries(schema.properties).map(([name, prop]) => ({
			name,
			type: prop.items?.type ? `${prop.type}<${prop.items.type}>` : (prop.type ?? "any"),
			required: required.has(name),
			description: prop.description ?? prop.format ?? (prop.enum ? `enum: ${prop.enum.join(", ")}` : ""),
			constraints: [
				prop.minimum != null ? `min: ${prop.minimum}` : "",
				prop.maximum != null ? `max: ${prop.maximum}` : "",
				prop.minLength != null ? `minLength: ${prop.minLength}` : "",
				prop.maxLength != null ? `maxLength: ${prop.maxLength}` : "",
			].filter(Boolean).join(", "),
		}));
	}

	function scrollToCategory(cat: string) {
		const el = document.getElementById(`cat-${cat}`);
		if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	onMount(() => {
		// Track active section on scroll
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						activeCategory = entry.target.id.replace("cat-", "");
					}
				}
			},
			{ rootMargin: "-20% 0px -70% 0px" }
		);

		(async () => {
			try {
				const res = await fetch("/api/docs");
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				routes = data.routes;
			} catch (e) {
				error = e instanceof Error ? e.message : "Failed to load docs";
			} finally {
				loading = false;
			}

			// Observe after routes load
			setTimeout(() => {
				for (const cat of categoryOrder) {
					const el = document.getElementById(`cat-${cat}`);
					if (el) observer.observe(el);
				}
			}, 100);
		})();

		return () => observer.disconnect();
	});

	let sidebarOpen = $state(false);
</script>

<svelte:head>
	<title>API Reference</title>
</svelte:head>

<div class="docs-layout">
	<!-- Mobile category toggle -->
	<button
		class="mobile-toggle md:hidden"
		onclick={() => (sidebarOpen = !sidebarOpen)}
	>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
		{sidebarOpen ? "Hide" : "Show"} Categories
	</button>

	<!-- Sidebar -->
	<aside class="docs-sidebar {sidebarOpen ? 'open' : ''}">
		<div class="sidebar-inner">
			<h3 class="sidebar-title">Categories</h3>
			<nav class="sidebar-nav">
				{#each categoryOrder as cat}
					<button
						class="sidebar-link {activeCategory === cat ? 'active' : ''}"
						onclick={() => { scrollToCategory(cat); sidebarOpen = false; }}
					>
						<span class="sidebar-count">{grouped[cat]?.length ?? 0}</span>
						{categoryLabels[cat] ?? cat}
					</button>
				{/each}
			</nav>
		</div>
	</aside>

	<!-- Main content -->
	<div class="docs-main">
		<div class="docs-header">
			<h1 class="docs-title">API Reference</h1>
			<p class="docs-subtitle">Auto-generated from application schemas</p>
			{#if !loading}
				<p class="docs-stats">{routes.length} endpoints across {categoryOrder.length} categories</p>
			{/if}
		</div>

		{#if loading}
			<div class="loading-state">Loading API documentation...</div>
		{:else if error}
			<div class="error-state">Error: {error}</div>
		{:else}
			{#each categoryOrder as cat}
				<section id="cat-{cat}" class="category-section">
					<h2 class="category-heading">{categoryLabels[cat] ?? cat}</h2>

					{#each grouped[cat] ?? [] as route}
						<div class="route-card">
							<div class="route-header">
								<span class="method-badge {methodColors[route.method] ?? 'bg-gray-600'}">
									{route.method}
								</span>
								<code class="route-path">{route.path}</code>
							</div>
							<p class="route-description">{route.description}</p>

							{#if route.responseDescription}
								<p class="route-response">Returns: {route.responseDescription}</p>
							{/if}

							{#if route.requestJsonSchema?.properties}
								{@const props = getSchemaProperties(route.requestJsonSchema)}
								{#if props.length > 0}
									<div class="schema-section">
										<h4 class="schema-title">Request Body</h4>
										<table class="schema-table">
											<thead>
												<tr>
													<th>Property</th>
													<th>Type</th>
													<th>Required</th>
													<th>Details</th>
												</tr>
											</thead>
											<tbody>
												{#each props as prop}
													<tr>
														<td><code>{prop.name}</code></td>
														<td><code class="type-code">{prop.type}</code></td>
														<td>{prop.required ? "Yes" : "No"}</td>
														<td class="details-cell">
															{prop.description}{#if prop.constraints}{#if prop.description}, {/if}{prop.constraints}{/if}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}
							{/if}
						</div>
					{/each}
				</section>
			{/each}
		{/if}
	</div>
</div>

<style>
	.docs-layout {
		display: flex;
		gap: 0;
		max-width: 1200px;
		margin: -1.5rem;
		min-height: calc(100vh - 4rem);
	}

	.docs-sidebar {
		display: none;
		width: 220px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
	}

	@media (min-width: 768px) {
		.docs-sidebar {
			display: block;
		}
	}

	.docs-sidebar.open {
		display: block;
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 30;
		width: 100%;
		height: auto;
		max-height: 60vh;
		border-right: none;
		border-bottom: 1px solid var(--color-border);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.sidebar-inner {
		padding: 1rem;
	}

	.sidebar-title {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		margin-bottom: 0.75rem;
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sidebar-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.5rem;
		min-height: 44px;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background 0.15s, color 0.15s;
		width: 100%;
	}

	.sidebar-link:hover {
		background: var(--color-surface-tertiary);
		color: var(--color-text-primary);
	}

	.sidebar-link.active {
		background: var(--color-surface-tertiary);
		color: var(--color-text-primary);
		font-weight: 500;
	}

	.sidebar-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.25rem;
		border-radius: 9999px;
		background: var(--color-surface-tertiary);
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.mobile-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		min-height: 44px;
		margin-bottom: 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-secondary);
		border: 1px solid var(--color-border);
		cursor: pointer;
	}

	@media (min-width: 768px) {
		.mobile-toggle {
			display: none;
		}
	}

	.docs-main {
		flex: 1;
		min-width: 0;
		padding: 1.5rem;
	}

	.docs-header {
		margin-bottom: 2rem;
	}

	.docs-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.docs-subtitle {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
	}

	.docs-stats {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
	}

	.loading-state,
	.error-state {
		padding: 2rem;
		text-align: center;
		color: var(--color-text-muted);
	}

	.error-state {
		color: #ef4444;
	}

	.category-section {
		margin-bottom: 2rem;
		scroll-margin-top: 1rem;
	}

	.category-heading {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: 1rem;
	}

	.route-card {
		padding: 0.75rem 1rem;
		margin-bottom: 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		background: var(--color-surface-secondary);
		min-width: 0;
		overflow: hidden;
	}

	.route-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.method-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 3.5rem;
		padding: 0.125rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 700;
		color: white;
		text-transform: uppercase;
		letter-spacing: 0.025em;
	}

	.route-path {
		font-size: 0.875rem;
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
		color: var(--color-text-primary);
		font-weight: 500;
		word-break: break-all;
	}

	.route-description {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		margin-top: 0.375rem;
	}

	.route-response {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
		font-style: italic;
	}

	.schema-section {
		margin-top: 0.75rem;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}

	.schema-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.375rem;
	}

	.schema-table {
		width: 100%;
		font-size: 0.8125rem;
		border-collapse: collapse;
	}

	.schema-table th {
		text-align: left;
		padding: 0.375rem 0.5rem;
		font-weight: 600;
		color: var(--color-text-muted);
		border-bottom: 1px solid var(--color-border);
		font-size: 0.75rem;
	}

	.schema-table td {
		padding: 0.375rem 0.5rem;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-secondary);
	}

	.schema-table tr:nth-child(even) td {
		background: var(--color-surface-tertiary);
	}

	.schema-table code {
		font-size: 0.75rem;
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
	}

	.type-code {
		color: #3b82f6;
	}

	.details-cell {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}
</style>
