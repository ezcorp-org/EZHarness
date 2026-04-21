<script lang="ts">
	let { projectId, currentPath }: { projectId: string; currentPath: string } = $props();

	let tabs = $derived([
		{
			label: "Overview",
			href: `/project/${projectId}`,
			active: currentPath === `/project/${projectId}` || currentPath === `/project/${projectId}/`,
			icon: "dashboard",
		},
		{
			label: "Chat",
			href: `/project/${projectId}/chat`,
			active: currentPath.includes("/chat"),
			icon: "chat",
		},
		{
			label: "Settings",
			href: `/project/${projectId}/settings`,
			active: currentPath.includes("/settings"),
			icon: "settings",
		},
	]);
</script>

<nav
	class="md:hidden fixed bottom-0 left-0 right-0 z-30 flex border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]"
	style="padding-bottom: env(safe-area-inset-bottom, 0px);"
	aria-label="Mobile navigation"
>
	{#each tabs as tab}
		<a
			href={tab.href}
			class="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors {tab.active
				? 'text-blue-500'
				: 'text-[var(--color-text-muted)]'}"
			style="min-height: 48px;"
			aria-current={tab.active ? "page" : undefined}
		>
			{#if tab.icon === "dashboard"}
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<rect x="3" y="3" width="7" height="7" rx="1" />
					<rect x="14" y="3" width="7" height="7" rx="1" />
					<rect x="3" y="14" width="7" height="7" rx="1" />
					<rect x="14" y="14" width="7" height="7" rx="1" />
				</svg>
			{:else if tab.icon === "chat"}
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
				</svg>
			{:else if tab.icon === "settings"}
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<circle cx="12" cy="12" r="3" />
				</svg>
			{/if}
			<span class="text-xs font-medium">{tab.label}</span>
		</a>
	{/each}
</nav>
