<script lang="ts">
	import { store, initStores } from "$lib/stores.svelte.js";
	import { onMount } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { initTheme } from "$lib/theme.js";
	import { matchShortcut, loadCustomShortcuts, type ShortcutBinding } from "$lib/shortcuts.js";
	import ProjectRail from "$lib/components/ProjectRail.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";
	import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
	import ToastContainer from "$lib/components/ToastContainer.svelte";
	import ImageLightbox from "$lib/components/ImageLightbox.svelte";
	import QuickStartChecklist from "$lib/components/QuickStartChecklist.svelte";
	import ConnectionBanner from "$lib/components/chat/ConnectionBanner.svelte";
	import PullToRefresh from "$lib/components/PullToRefresh.svelte";
	import SwipeDrawer from "$lib/components/SwipeDrawer.svelte";
	import TeamChatPanel from "$lib/components/TeamChatPanel.svelte";

	let { children } = $props();
	let commandPaletteOpen = $state(false);
	let shortcutHelpOpen = $state(false);
	let shortcuts = $state<ShortcutBinding[]>([]);
	let isAdmin = $state(false);
	let currentUser = $state<{ id: string; name: string; email: string; role: string } | null>(null);
	let userMenuOpen = $state(false);

	function toggleSidebar() {
		store.sidebarCollapsed = !store.sidebarCollapsed;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem("pi-sidebar-collapsed", String(store.sidebarCollapsed));
		}
	}

	async function handleLogout() {
		await fetch("/api/auth/logout", { method: "POST" });
		goto("/login");
	}

	function closeUserMenu(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest(".user-menu-container")) {
			userMenuOpen = false;
		}
	}

	// Save last visited path for resume-on-reopen
	afterNavigate(({ to }) => {
		if (to?.url.pathname && to.url.pathname !== "/") {
			localStorage.setItem("ezcorp-last-path", to.url.pathname + to.url.search);
		}
	});

	onMount(() => {
		// Remove splash screen after hydration
		const splash = document.getElementById('splash');
		if (splash) {
			splash.style.opacity = '0';
			setTimeout(() => splash.remove(), 300);
		}

		initTheme();
		const cleanup = initStores();
		shortcuts = loadCustomShortcuts();

		// Fetch current user for nav and user menu
		fetch("/api/auth/me")
			.then((r) => r.json())
			.then((me) => {
				if (me.user) {
					currentUser = me.user;
					if (me.user.role === "admin") isAdmin = true;
				}
			})
			.catch(() => {});

		function handleGlobalKeydown(e: KeyboardEvent) {
			const action = matchShortcut(e, shortcuts);
			if (!action) return;
			e.preventDefault();

			switch (action) {
				case "palette":
					commandPaletteOpen = !commandPaletteOpen;
					break;
				case "new-chat":
					if (store.activeProjectId !== "global") {
						import("$lib/api.js").then(({ createConversation }) => {
							createConversation({ projectId: store.activeProjectId })
								.then((conv) => {
									goto(`/project/${store.activeProjectId}/chat/${conv.id}`);
								})
								.catch(() => {});
						});
					}
					break;
				case "help":
					shortcutHelpOpen = !shortcutHelpOpen;
					break;
				case "sidebar-toggle":
					toggleSidebar();
					break;
			}
		}

		document.addEventListener("keydown", handleGlobalKeydown);
		document.addEventListener("click", closeUserMenu);
		return () => {
			cleanup();
			document.removeEventListener("keydown", handleGlobalKeydown);
			document.removeEventListener("click", closeUserMenu);
		};
	});

	let activeProject = $derived(store.projects.find((p) => p.id === store.activeProjectId));

	// Keep `store.activeProjectId` in lock-step with the URL. Direct links
	// (`/project/:id/...`, bookmark, refresh, first load) would otherwise leave
	// the store showing the previously-cached project — which breaks downstream
	// consumers that read `activeProjectId` (file-mention search, etc.).
	$effect(() => {
		const routeProjectId = page.params.id;
		if (routeProjectId && routeProjectId !== store.activeProjectId) {
			store.activeProjectId = routeProjectId;
			if (typeof localStorage !== "undefined") {
				try { localStorage.setItem("activeProjectId", routeProjectId); } catch {}
			}
		}
	});

	// Chat routes use absolute positioning and need full-bleed (no padding)
	let isChatRoute = $derived(page.url.pathname.includes('/chat'));

	let isGlobalProject = $derived(store.activeProjectId === "global");

	function isLinkActive(href: string): boolean {
		const path = page.url.pathname;
		// Home (/) needs exact match only
		if (href === "/") return path === href;
		return path === href || path.startsWith(href + "/");
	}

	let navLinks = $derived<{ href: string; label: string; group?: string }[]>([
		...(isGlobalProject
			? [
					{ href: "/", label: "Home" },
					{ href: "/project/global/chat", label: "Chat" },
					{ href: "/active-agents", label: "Active Agents" },
					{ href: "/agents", label: "Agents", group: "Build" },
					{ href: "/pipelines", label: "Pipelines", group: "Build" },
					{ href: "/extensions", label: "Extensions", group: "Build" },
					{ href: "/marketplace", label: "Marketplace", group: "Discover" },
					{ href: "/memories", label: "Memories", group: "Discover" },
					{ href: "/observability", label: "Analytics", group: "Manage" },
					{ href: "/settings", label: "Settings", group: "Manage" },
				]
			: [
					{ href: `/project/${store.activeProjectId}/chat`, label: "Chat" },
					{ href: "/memories", label: "Memories" },
					{ href: `/project/${store.activeProjectId}/settings`, label: "Project Settings" },
					{ href: "/agents", label: "Agents", group: "Platform" },
					{ href: "/pipelines", label: "Pipelines", group: "Platform" },
					{ href: "/extensions", label: "Extensions", group: "Platform" },
					{ href: "/marketplace", label: "Marketplace", group: "Platform" },
					{ href: "/observability", label: "Analytics", group: "Platform" },
					{ href: "/settings", label: "Settings", group: "Platform" },
				]),
		{ href: "/docs", label: "API Docs" },
		...(isAdmin ? [
			{ href: "/admin/dashboard", label: "System", group: "Admin" },
			{ href: "/admin/moderation", label: "Moderation", group: "Admin" },
		] : []),
	]);

</script>

<div class="flex h-[100dvh] bg-[var(--color-surface)] text-[var(--color-text-primary)]" style="height: 100vh; height: 100dvh; padding-bottom: env(safe-area-inset-bottom, 0px);">
	<!-- Project Rail (hidden on mobile, shown in overlay) -->
	<div class="hidden md:flex">
		<ProjectRail />
	</div>

	<!-- Desktop sidebar -->
	<aside
		class="hidden md:flex shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] transition-[width] duration-200 ease-in-out overflow-hidden {store.sidebarCollapsed ? 'w-0 border-r-0' : 'w-56'}"
		aria-label="Sidebar"
	>
		<div class="border-b border-[var(--color-border)] px-4 py-3">
			<div class="flex items-center gap-2">
				<button
					onclick={() => (commandPaletteOpen = true)}
					class="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-secondary)]"
					title="Command palette (Ctrl+K)"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
				</button>
				<ThemeToggle />
				<span
					class="h-2.5 w-2.5 rounded-full {store.connected ? 'bg-green-500' : 'bg-red-500'}"
					title={store.connected ? "Connected" : "Disconnected"}
				></span>
				<!-- Collapse button -->
				<button
					onclick={toggleSidebar}
					class="ml-auto rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
					title="Collapse sidebar (Ctrl+\\)"
					aria-label="Collapse sidebar"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
					</svg>
				</button>
			</div>
			<a href="/" class="mt-2 block truncate text-lg font-bold hover:text-[var(--color-accent)] transition-colors" title="Go to Home">{activeProject?.name ?? "EZCorp"}</a>
		</div>
		<nav class="scrollbar-hide flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label="Main navigation">
			{#each navLinks as link, i}
				{#if link.group && (i === 0 || navLinks[i - 1]?.group !== link.group)}
					<div class="mt-3 mb-1 px-3 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
						{link.group}
					</div>
				{/if}
				{@const active = isLinkActive(link.href)}
				<a
					href={link.href}
					class="rounded-md px-3 py-2 text-sm font-medium transition-colors {active ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
					aria-current={active ? 'page' : undefined}
				>
					{link.label}
				</a>
			{/each}
			<div class="mt-auto">
				<QuickStartChecklist />
				<!-- User menu -->
				{#if currentUser}
					<div class="user-menu-container relative mt-2 border-t border-[var(--color-border)] pt-2">
						<button
							onclick={() => (userMenuOpen = !userMenuOpen)}
							class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
						>
							<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
								{currentUser.name.charAt(0).toUpperCase()}
							</span>
							<span class="truncate text-left">{currentUser.name}</span>
							<svg class="ml-auto h-3 w-3 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
							</svg>
						</button>
						{#if userMenuOpen}
							<div class="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg z-50">
								<a
									href="/account"
									onclick={() => (userMenuOpen = false)}
									class="block px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors rounded-t-md"
								>
									Account
								</a>
								<div class="border-t border-[var(--color-border)]"></div>
								<button
									onclick={handleLogout}
									class="block w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-[var(--color-surface-tertiary)] transition-colors rounded-b-md"
								>
									Logout
								</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</nav>
	</aside>

	<!-- Expand button (when sidebar collapsed on desktop) -->
	{#if store.sidebarCollapsed}
		<button
			onclick={toggleSidebar}
			class="hidden md:flex items-center justify-center w-6 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			title="Expand sidebar (Ctrl+\\)"
			aria-label="Expand sidebar"
		>
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</button>
	{/if}

	<!-- Main content -->
	<main class="relative flex-1 overflow-y-auto {isChatRoute ? 'flex flex-col' : ''}">
		<!-- Mobile header (hidden on chat routes - chat has its own mobile header) -->
		{#if !isChatRoute}
		<div class="flex md:hidden items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3">
			<button
				onclick={() => (store.mobileMenuOpen = true)}
				class="flex items-center justify-center rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				aria-label="Open menu"
				style="min-width: 44px; min-height: 44px;"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<a href="/" class="text-sm font-bold truncate flex-1 hover:text-[var(--color-accent)] transition-colors" title="Go to Home">{activeProject?.name ?? "EZCorp"}</a>
			<ThemeToggle />
			<span
				class="h-2.5 w-2.5 rounded-full {store.connected ? 'bg-green-500' : 'bg-red-500'}"
				title={store.connected ? "Connected" : "Disconnected"}
			></span>
		</div>
		{/if}
		{#if isChatRoute}
			<div class="flex-1 relative">
				{@render children()}
			</div>
		{:else}
			<div class="p-6">
				{@render children()}
			</div>
		{/if}
	</main>
</div>

<PullToRefresh />
<ConnectionBanner />
<ToastContainer />
<ImageLightbox />

<!-- Mobile overlay drawer -->
<SwipeDrawer
	open={store.mobileMenuOpen}
	side="left"
	width="w-[calc(72px+14rem)]"
	maxWidth="max-w-[85vw]"
	onclose={() => (store.mobileMenuOpen = false)}
	ariaLabel="Mobile navigation"
>
	<div class="flex h-full">
		<ProjectRail />
		<aside class="flex flex-1 flex-col bg-[var(--color-surface-secondary)]">
			<div class="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-4">
				<a href="/" class="text-lg font-bold truncate hover:text-[var(--color-accent)] transition-colors" title="Go to Home">{activeProject?.name ?? "EZCorp"}</a>
				<span
					class="ml-auto h-2.5 w-2.5 rounded-full {store.connected ? 'bg-green-500' : 'bg-red-500'}"
					title={store.connected ? "Connected" : "Disconnected"}
				></span>
				<button
					onclick={() => (store.mobileMenuOpen = false)}
					class="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)]"
					aria-label="Close menu"
					style="min-width: 44px; min-height: 44px;"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<nav class="scrollbar-hide flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
				{#each navLinks as link, i}
					{#if link.group && (i === 0 || navLinks[i - 1]?.group !== link.group)}
						<div class="mt-3 mb-1 px-3 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
							{link.group}
						</div>
					{/if}
					{@const active = isLinkActive(link.href)}
					<a
						href={link.href}
						onclick={() => (store.mobileMenuOpen = false)}
						class="rounded-md px-3 py-2 text-sm font-medium transition-colors {active ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
						style="min-height: 44px; display: flex; align-items: center;"
						aria-current={active ? 'page' : undefined}
					>
						{link.label}
					</a>
				{/each}
			</nav>
		</aside>
	</div>
</SwipeDrawer>

<CommandPalette
	open={commandPaletteOpen}
	activeProjectId={store.activeProjectId}
	onclose={() => (commandPaletteOpen = false)}
/>

<ShortcutHelp open={shortcutHelpOpen} onclose={() => (shortcutHelpOpen = false)} />

<!-- Global team chat panel (triggered from anywhere via openTeamPanel) -->
<TeamChatPanel />

