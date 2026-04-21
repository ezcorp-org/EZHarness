<script lang="ts">
	let { selectedIds = [], onchange, disabled = false, single = false }: {
		selectedIds: string[];
		onchange: (ids: string[]) => void;
		disabled?: boolean;
		single?: boolean;
	} = $props();

	interface Project {
		id: string;
		name: string;
		icon?: string;
	}

	let projects = $state<Project[]>([]);
	let open = $state(false);
	let search = $state("");
	let dropdownEl: HTMLDivElement | undefined = $state();
	let triggerEl: HTMLButtonElement | undefined = $state();

	let isGlobal = $derived(selectedIds.length === 0);

	let filtered = $derived(
		search
			? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
			: projects,
	);

	let selectedProject = $derived(
		single && selectedIds.length > 0
			? projects.find((p) => p.id === selectedIds[0])
			: undefined,
	);

	let triggerLabel = $derived(
		single
			? (selectedProject?.name ?? "Select project")
			: isGlobal
				? "Org-wide"
				: selectedIds.length === 1
					? "1 project"
					: `${selectedIds.length} projects`,
	);

	$effect(() => {
		fetch("/api/projects")
			.then((r) => r.ok ? r.json() : [])
			.then((data: Project[]) => { projects = data; })
			.catch(() => {});
	});

	function handleClickOutside(e: MouseEvent) {
		if (
			dropdownEl && !dropdownEl.contains(e.target as Node) &&
			triggerEl && !triggerEl.contains(e.target as Node)
		) {
			open = false;
		}
	}

	$effect(() => {
		if (open) {
			document.addEventListener("click", handleClickOutside, true);
			return () => document.removeEventListener("click", handleClickOutside, true);
		}
	});

	function selectGlobal() {
		onchange([]);
	}

	function toggleProject(id: string) {
		if (single) {
			onchange([id]);
			open = false;
			return;
		}
		if (selectedIds.includes(id)) {
			onchange(selectedIds.filter((s) => s !== id));
		} else {
			onchange([...selectedIds, id]);
		}
	}
</script>

<div class="relative" data-testid="project-picker">
	<button
		bind:this={triggerEl}
		data-testid="project-picker-trigger"
		{disabled}
		onclick={() => { open = !open; }}
		class={single
			? "flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
			: "flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-secondary)] disabled:cursor-not-allowed disabled:opacity-50"}
	>
		{#if isGlobal && !single}
			<svg class="h-3 w-3 text-[var(--color-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
		{:else}
			<svg class="h-3 w-3 text-[var(--color-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
		{/if}
		{triggerLabel}
		<svg class="h-3 w-3 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
	</button>

	{#if open}
		<div
			bind:this={dropdownEl}
			data-testid="project-picker-dropdown"
			class="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--color-border)] shadow-xl {single ? 'bg-[var(--color-surface-secondary)]' : 'bg-[var(--color-surface)]'}"
		>
			<!-- Search -->
			<div class="border-b border-[var(--color-border)] p-2">
				<input
					data-testid="project-picker-search"
					bind:value={search}
					type="text"
					placeholder="Search projects..."
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
				/>
			</div>

			<div class="max-h-60 overflow-y-auto py-1">
				{#if !single}
					<!-- Global option -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						data-testid="project-picker-global"
						onclick={selectGlobal}
						class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-surface-secondary)]"
					>
						<input type="checkbox" checked={isGlobal} class="pointer-events-none rounded" readonly />
						<svg class="h-3.5 w-3.5 text-[var(--color-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
						<span class="text-[var(--color-text-primary)]">Org-wide (Global)</span>
					</div>

					{#if filtered.length > 0}
						<div class="mx-2 my-1 border-t border-[var(--color-border)]"></div>
					{/if}
				{/if}

				{#each filtered as project (project.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						data-testid="project-picker-item-{project.id}"
						onclick={() => toggleProject(project.id)}
						class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-surface-secondary)]"
					>
						{#if !single}
							<input type="checkbox" checked={selectedIds.includes(project.id)} class="pointer-events-none rounded" readonly />
						{/if}
						{#if project.icon}
							<span class="text-sm">{project.icon}</span>
						{:else}
							<svg class="h-3.5 w-3.5 text-[var(--color-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
						{/if}
						<span class="text-[var(--color-text-primary)]">{project.name}</span>
					</div>
				{/each}

				{#if filtered.length === 0 && search}
					<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No projects match "{search}"</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
