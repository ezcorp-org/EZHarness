<script lang="ts">
	import { page } from "$app/state";
	import { visibleNavItems, activeNavId } from "$lib/settings-nav.js";

	let { children } = $props();

	type CurrentUser = { id: string; email: string; name: string; role: "admin" | "member" };
	let currentUser = $state<CurrentUser | null>(null);

	$effect(() => {
		(async () => {
			try {
				const res = await fetch("/api/auth/me");
				if (res.ok) {
					const data = await res.json();
					currentUser = data.user;
				}
			} catch { /* silent */ }
		})();
	});

	const isAdmin = $derived(currentUser?.role === "admin");
	const navItems = $derived(visibleNavItems(isAdmin));
	const activeId = $derived(activeNavId(page.url.pathname));
</script>

<div class="mx-auto max-w-5xl">
	<h1 class="mb-4 text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>
	<div class="md:flex md:items-start md:gap-8">
		<nav
			aria-label="Settings sections"
			data-testid="settings-nav"
			class="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-2 md:mx-0 md:mb-0 md:w-48 md:shrink-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
		>
			{#each navItems as item}
				<a
					href={item.href}
					aria-current={activeId === item.id ? "page" : undefined}
					data-testid="settings-nav-{item.id}"
					class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors {item.child ? 'md:ml-3' : ''} {activeId === item.id
						? 'bg-[var(--color-surface-tertiary)] font-medium text-[var(--color-text-primary)]'
						: 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)]'}"
				>
					{item.label}
					{#if item.adminOnly}
						<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">admin</span>
					{/if}
				</a>
			{/each}
		</nav>
		<div class="min-w-0 flex-1 space-y-6">
			{@render children()}
		</div>
	</div>
</div>
