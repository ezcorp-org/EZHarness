<script lang="ts">
	import { goto } from "$app/navigation";
	import { store, setActiveProjectId } from "$lib/stores.svelte.js";

	const BG_COLORS = [
		"bg-blue-600",
		"bg-green-600",
		"bg-purple-600",
		"bg-orange-600",
		"bg-pink-600",
		"bg-teal-600",
		"bg-indigo-600",
		"bg-red-600",
	];

	function hashColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash * 31 + name.charCodeAt(i)) | 0;
		}
		return BG_COLORS[Math.abs(hash) % BG_COLORS.length]!;
	}

	let hoveredId = $state<string | null>(null);
	// Button rect for the currently hovered project — used to position the
	// tooltip with `position: fixed`, which escapes the `overflow-y-auto`
	// clipping on the scrollable project list container.
	let hoveredRect = $state<{ left: number; top: number; height: number } | null>(null);

	function selectProject(id: string) {
		setActiveProjectId(id);
		goto(id === "global" ? "/project/global/chat" : `/project/${id}`);
	}

	function onProjectEnter(id: string, e: MouseEvent) {
		hoveredId = id;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		hoveredRect = { left: r.right, top: r.top, height: r.height };
	}

	function onProjectLeave() {
		hoveredId = null;
		hoveredRect = null;
	}
</script>

<div class="flex h-full w-[72px] shrink-0 flex-col items-center bg-[var(--color-surface-secondary)] py-3">
	<!-- Home button -->
	<button
		class="group relative mb-2 flex cursor-pointer items-center"
		onclick={() => selectProject("global")}
		onmouseenter={() => (hoveredId = "__home__")}
		onmouseleave={() => (hoveredId = null)}
		aria-label="Home"
	>
		<!-- Active/hover pill -->
		<div
			class="absolute left-0 w-1 rounded-r-full bg-[var(--color-text-primary)] transition-all duration-200 {store.activeProjectId === 'global'
				? 'h-10'
				: hoveredId === '__home__'
					? 'h-5'
					: 'h-0'}"
			style="top: 50%; transform: translateY(-50%);"
		></div>

		<div
			class="ml-3 flex h-12 w-12 items-center justify-center transition-all duration-200
				{store.activeProjectId === 'global'
				? 'rounded-2xl bg-blue-600'
				: 'rounded-full bg-[var(--color-surface-tertiary)] group-hover:rounded-2xl group-hover:bg-blue-600'}"
		>
			<svg class="h-6 w-6 text-[var(--color-text-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" />
			</svg>
		</div>

		<!-- Tooltip -->
		{#if hoveredId === "__home__"}
			<div class="absolute left-[76px] z-50 whitespace-nowrap rounded-md bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] shadow-lg ring-1 ring-[var(--color-border)]">
				Home
			</div>
		{/if}
	</button>

	<!-- Divider -->
	<div class="mx-auto mb-2 h-0.5 w-8 rounded-full bg-[var(--color-border)]"></div>

	<!-- Project icons -->
	<div class="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
		{#each store.projects.filter(p => p.id !== "global") as project (project.id)}
			{@const isActive = store.activeProjectId === project.id}
			<button
				class="group relative flex cursor-pointer items-center"
				onclick={() => selectProject(project.id)}
				onmouseenter={(e) => onProjectEnter(project.id, e)}
				onmouseleave={onProjectLeave}
				aria-label={project.name}
			>
				<!-- Active/hover pill -->
				<div
					class="absolute left-0 w-1 rounded-r-full bg-[var(--color-text-primary)] transition-all duration-200 {isActive
						? 'h-10'
						: hoveredId === project.id
							? 'h-5'
							: 'h-0'}"
					style="top: 50%; transform: translateY(-50%);"
				></div>

				<div
					class="ml-3 flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-200
						{isActive
						? 'rounded-2xl'
						: 'rounded-full group-hover:rounded-2xl'} {project.icon ? '' : hashColor(project.name)}"
				>
					{#if project.icon}
						<img src={project.icon} alt={project.name} class="h-full w-full object-cover" />
					{:else}
						<span class="text-lg font-semibold text-white">{project.name.charAt(0).toUpperCase()}</span>
					{/if}
				</div>

			</button>
		{/each}
	</div>

	<!-- Add project button -->
	<button
		class="group relative mt-2 flex cursor-pointer items-center"
		onclick={() => goto("/new-project")}
		onmouseenter={() => (hoveredId = "__add__")}
		onmouseleave={() => (hoveredId = null)}
		aria-label="Add project"
	>
		<div
			class="ml-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)] text-green-500 transition-all duration-200 group-hover:rounded-2xl group-hover:bg-green-600 group-hover:text-white"
		>
			<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
			</svg>
		</div>

		{#if hoveredId === "__add__"}
			<div class="absolute left-[76px] z-50 whitespace-nowrap rounded-md bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] shadow-lg ring-1 ring-[var(--color-border)]">
				Add Project
			</div>
		{/if}
	</button>
</div>

<!-- Project tooltip rendered with position:fixed so it escapes the
	 `overflow-y-auto` clip on the project-list container above. -->
{#if hoveredId && hoveredRect}
	{@const proj = store.projects.find((p) => p.id === hoveredId)}
	{#if proj}
		<div
			class="pointer-events-none fixed z-50 max-w-xs rounded-md bg-[var(--color-surface)] px-3 py-2 text-left shadow-lg ring-1 ring-[var(--color-border)]"
			style="left: {hoveredRect.left + 8}px; top: {hoveredRect.top + hoveredRect.height / 2}px; transform: translateY(-50%);"
		>
			<div class="truncate text-sm font-medium text-[var(--color-text-primary)]">{proj.name}</div>
			{#if proj.path}
				<div class="mt-0.5 truncate font-mono text-xs text-[var(--color-text-muted)]">{proj.path}</div>
			{/if}
		</div>
	{/if}
{/if}
