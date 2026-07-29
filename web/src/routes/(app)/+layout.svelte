<script lang="ts">
	import { store, initStores, noteSidebarUserOverride } from "$lib/stores.svelte.js";
	import { onMount } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { initTheme } from "$lib/theme.js";
	import { matchShortcut, loadCustomShortcuts, type ShortcutBinding } from "$lib/shortcuts.js";
	import { startAuthKeepalive } from "$lib/auth-keepalive.js";
	import { clearResumeState } from "$lib/resume-path.js";
	import { isIconUrl } from "$lib/project-icon.js";
	import ProjectRail from "$lib/components/ProjectRail.svelte";
	import HubNavSection from "$lib/components/hub/HubNavSection.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";
	import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
	import ToastContainer from "$lib/components/ToastContainer.svelte";
	import ImageLightbox from "$lib/components/ImageLightbox.svelte";
	import QuickStartChecklist from "$lib/components/QuickStartChecklist.svelte";
	import BriefingNudge from "$lib/components/BriefingNudge.svelte";
	import ConnectionBanner from "$lib/components/chat/ConnectionBanner.svelte";
	import PullToRefresh from "$lib/components/PullToRefresh.svelte";
	import SwipeDrawer from "$lib/components/SwipeDrawer.svelte";
	import TeamChatPanel from "$lib/components/TeamChatPanel.svelte";
	import DockHost from "$lib/components/tool-cards/DockHost.svelte";
	import PendingPermissionTray from "$lib/components/tool-cards/PendingPermissionTray.svelte";
	import EzPanel from "$lib/components/ez/EzPanel.svelte";

	let { children } = $props();
	let commandPaletteOpen = $state(false);
	// Which view the palette lands in when opened via a shortcut:
	//   "search"   — Cmd+K (action "palette"), search-first
	//   "commands" — Cmd+Shift+P (action "palette-commands"), command-first
	// Consumed by CommandPalette in Plan 06; passed through here.
	let paletteInitialView = $state<"search" | "commands">("search");
	let shortcutHelpOpen = $state(false);
	let shortcuts = $state<ShortcutBinding[]>([]);
	let isAdmin = $state(false);
	let currentUser = $state<{ id: string; name: string; email: string; role: string } | null>(null);
	let userMenuOpen = $state(false);

	function toggleSidebar() {
		// User-action precedence rule (canvas-dock-sdk plan §7.2): manually
		// toggling the sidebar while the dock is open marks the dock slot's
		// `userOverrode = true`, so close-on-dock skips the auto-restore.
		noteSidebarUserOverride();
		store.sidebarCollapsed = !store.sidebarCollapsed;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem("pi-sidebar-collapsed", String(store.sidebarCollapsed));
		}
	}

	async function handleLogout() {
		await fetch("/api/auth/logout", { method: "POST" });
		// Clear resume state so the NEXT user on this device never resumes into
		// the previous user's project / conversation.
		if (typeof localStorage !== "undefined") clearResumeState(localStorage);
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

		// Command Deck: detect macOS for the ⌘ vs Ctrl kbd hints.
		if (typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)) {
			metaKey = "⌘";
		}

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
					paletteInitialView = "search";
					commandPaletteOpen = !commandPaletteOpen;
					break;
				case "palette-commands":
					paletteInitialView = "commands";
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
		const stopKeepalive = startAuthKeepalive();
		return () => {
			cleanup();
			stopKeepalive();
			document.removeEventListener("keydown", handleGlobalKeydown);
			document.removeEventListener("click", closeUserMenu);
		};
	});

	let activeProject = $derived(store.projects.find((p) => p.id === store.activeProjectId));

	// Command Deck: platform-aware modifier label for keyboard-shortcut hints
	// (⌘ on macOS, Ctrl elsewhere). Pure presentation — drives the mono kbd
	// chips in the command column and the status bar.
	let metaKey = $state("Ctrl");
	// Project count shown in the status line (excludes the synthetic "global").
	let projectCount = $derived(store.projects.filter((p) => p.id !== "global").length);

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

	// Active chat conversation id (from `/chat/<convId>` segment). Used to
	// drive responsive width for the right-side canvas dock — when a dock
	// is open in the current conversation, `<main>` shrinks to leave room
	// for the panel instead of being overlaid.
	let activeChatConvId = $derived.by((): string | null => {
		const m = page.url.pathname.match(/\/chat\/([^/?#]+)/);
		return m?.[1] ?? null;
	});

	// Viewport-aware mobile breakpoint — mirror DockHost's threshold. On
	// mobile the dock is a full-screen overlay, so the chat doesn't shrink.
	let viewportWidth = $state<number>(typeof window !== "undefined" ? window.innerWidth : 1280);
	$effect(() => {
		if (typeof window === "undefined") return;
		const onResize = () => { viewportWidth = window.innerWidth; };
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	});
	let isMobileViewport = $derived(viewportWidth <= 640);

	// How much to reserve on the right edge for the dock. Zero on:
	//   - non-chat routes (dock isn't visible)
	//   - chat routes with no open dock
	//   - mobile viewports (dock covers the chat)
	let reservedDockPx = $derived.by((): number => {
		if (!activeChatConvId) return 0;
		if (!store.dockState[activeChatConvId]) return 0;
		if (isMobileViewport) return 0;
		return store.dockSizePx;
	});

	let isGlobalProject = $derived(store.activeProjectId === "global");

	function isLinkActive(href: string): boolean {
		const path = page.url.pathname;
		// Home (/) needs exact match only
		if (href === "/") return path === href;
		return path === href || path.startsWith(href + "/");
	}

	let navLinks = $derived<{ href: string; label: string; group?: string; hub?: boolean }[]>([
		...(isGlobalProject
			? [
					{ href: "/project/global/chat", label: "Chat" },
					{ href: "/hub", label: "Hub", hub: true },
					{ href: "/active-agents", label: "Active Agents" },
					{ href: "/agents", label: "Agents", group: "Build" },
					{ href: "/commands", label: "Commands", group: "Build" },
					{ href: "/workflows", label: "Workflows", group: "Build" },
					{ href: "/extensions", label: "Extensions", group: "Build" },
					{ href: "/marketplace", label: "Marketplace", group: "Discover" },
					{ href: "/memories", label: "Memories", group: "Discover" },
					{ href: "/observability", label: "Analytics", group: "Manage" },
					{ href: "/settings", label: "Settings", group: "Manage" },
				]
			: [
					{ href: `/project/${store.activeProjectId}/chat`, label: "Chat" },
					{ href: `/project/${store.activeProjectId}/hub`, label: "Hub", hub: true },
					{ href: "/memories", label: "Memories" },
					{ href: `/project/${store.activeProjectId}/settings`, label: "Project Settings" },
					{ href: "/agents", label: "Agents", group: "Platform" },
					{ href: "/commands", label: "Commands", group: "Platform" },
					{ href: "/workflows", label: "Workflows", group: "Platform" },
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

	// Command Deck breadcrumb: label for the current section, resolved from the
	// active nav link (falls back to the first path segment). Pure presentation.
	let breadcrumbLabel = $derived.by((): string => {
		const match = navLinks.find((l) => isLinkActive(l.href));
		if (match) return match.label;
		const seg = page.url.pathname.split("/").filter(Boolean)[0];
		return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Home";
	});

</script>

<!--
	Phase 49.1 — Mobile-responsive sidebar.

	Breakpoint policy: at `<lg` (`<1024px`), the project rail and the
	desktop sidebar are hidden; a hamburger button in the mobile header
	opens `SwipeDrawer` instead. At `≥lg` they render inline as before.

	The drawer infrastructure (`SwipeDrawer` + `store.mobileMenuOpen`)
	already existed for `<md`; this phase widens the threshold to `<lg`
	so tablets and small laptops also get the drawer treatment, per
	v1.3 Phase 49 spec § 49.1.1.
-->
<div class="flex h-[100dvh] bg-[var(--color-surface)] text-[var(--color-text-primary)]" style="height: 100vh; height: 100dvh; padding-bottom: env(safe-area-inset-bottom, 0px);">
	<!-- Project Rail (hidden below `lg`, shown in overlay drawer) -->
	<div class="hidden lg:flex" data-app-rail>
		<ProjectRail />
	</div>

	<!-- Desktop command column (Command Deck) -->
	<aside
		class="hidden lg:flex shrink-0 flex-col deck-column transition-[width] duration-150 ease-out overflow-hidden {store.sidebarCollapsed ? 'w-0 border-r-0' : 'w-60'}"
		aria-label="Sidebar"
		data-testid="desktop-sidebar"
	>
		<!-- Header bar: command-palette trigger + window controls -->
		<div class="flex h-11 items-center gap-1 border-b border-[var(--color-border)] px-2">
			<button
				onclick={() => (commandPaletteOpen = true)}
				class="group flex min-w-0 flex-1 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-left text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-secondary)]"
				title="Command palette ({metaKey}+K)"
			>
				<svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
						d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
				</svg>
				<span class="truncate text-xs">Search</span>
				<span class="deck-kbd ml-auto">{metaKey} K</span>
			</button>
			<ThemeToggle />
			<!-- Collapse button -->
			<button
				onclick={toggleSidebar}
				class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				title="Collapse sidebar ({metaKey}+\\)"
				aria-label="Collapse sidebar"
				data-testid="sidebar-collapse-btn"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
		</div>

		<!-- Active-context line: project name + identity (the home link) -->
		<a
			href="/"
			class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 transition-colors hover:bg-[var(--color-surface-tertiary)]"
			title="Go to Home"
			aria-label="Home"
		>
			<!-- Project logo (ProjectRail / command-palette parity): the project's
			     icon image when one is set, else a colored first-letter avatar. -->
			<span
				class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-sm font-mono text-[10px] font-bold text-[var(--color-accent-contrast)] {isIconUrl(activeProject?.icon) ? '' : 'bg-[var(--color-accent)]'}"
				data-testid="active-context-avatar"
			>
				{#if activeProject && isIconUrl(activeProject.icon)}
					<img src={activeProject.icon} alt={activeProject.name} class="h-full w-full object-cover" />
				{:else}
					{(activeProject?.name ?? "EZ").charAt(0).toUpperCase()}
				{/if}
			</span>
			<span class="min-w-0 flex-1">
				<span
					class="block truncate text-sm font-semibold leading-tight text-[var(--color-text-primary)]"
					data-testid="active-context-name">{activeProject?.name ?? "EZCorp"}</span>
				<span class="block truncate font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{isGlobalProject ? "workspace" : "project"}</span>
			</span>
		</a>

		<nav class="scrollbar-hide flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-2" aria-label="Main navigation">
			{#each navLinks as link, i}
				{#if link.group && (i === 0 || navLinks[i - 1]?.group !== link.group)}
					<div class="deck-section mt-3 mb-1 px-2.5 pt-2 first:mt-0 first:pt-0">
						{link.group}
					</div>
				{/if}
				{@const active = isLinkActive(link.href)}
				{#if link.hub}
					<HubNavSection hubBase={link.href} currentPath={page.url.pathname} {active} />
				{:else}
					<a
						href={link.href}
						class="deck-row"
						aria-current={active ? 'page' : undefined}
					>
						<span class="truncate">{link.label}</span>
					</a>
				{/if}
			{/each}
			<div class="mt-auto">
				<BriefingNudge />
				<QuickStartChecklist />
				<!-- User menu -->
				{#if currentUser}
					<div class="user-menu-container relative mt-2 border-t border-[var(--color-border)] pt-2">
						<button
							onclick={() => (userMenuOpen = !userMenuOpen)}
							class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
						>
							<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-blue-600 font-mono text-xs font-bold text-white">
								{currentUser.name.charAt(0).toUpperCase()}
							</span>
							<span class="truncate text-left">{currentUser.name}</span>
							<svg class="ml-auto h-3 w-3 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
							</svg>
						</button>
						{#if userMenuOpen}
							<div class="absolute bottom-full left-0 right-0 mb-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] shadow-lg z-50">
								<a
									href="/account"
									onclick={() => (userMenuOpen = false)}
									class="block px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
								>
									Account
								</a>
								<div class="border-t border-[var(--color-border)]"></div>
								<button
									onclick={handleLogout}
									class="block w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-[var(--color-surface-tertiary)] transition-colors"
								>
									Logout
								</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</nav>

		<!-- Persistent status bar (IDE / terminal status line) -->
		<div class="deck-statusbar" data-deck-statusbar data-testid="deck-statusbar">
			<span class="deck-statusbar__item" title={store.connected ? "Connected" : "Disconnected"}>
				<span
					class="deck-statusbar__dot {store.connected ? 'bg-green-500 deck-live' : 'bg-red-500'}"
					style="color: {store.connected ? 'var(--color-green-500, #25b56c)' : 'var(--color-red-500, #f0524d)'};"
				></span>
				<span>{store.connected ? "online" : "offline"}</span>
			</span>
			<span class="deck-statusbar__sep"></span>
			<span class="deck-statusbar__item truncate" title="Active workspace">{isGlobalProject ? "global" : (activeProject?.name ?? "—")}</span>
			<span class="deck-statusbar__sep"></span>
			<span class="deck-statusbar__item" title="Project count">{projectCount} proj</span>
			<span class="deck-statusbar__item ml-auto" title="EZCorp Command Deck">EZ</span>
		</div>
	</aside>

	<!-- Expand button (when sidebar collapsed on desktop, ≥lg only) -->
	{#if store.sidebarCollapsed}
		<button
			onclick={toggleSidebar}
			data-app-rail
			class="hidden lg:flex items-center justify-center w-6 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			title="Expand sidebar ({metaKey}+\\)"
			aria-label="Expand sidebar"
			data-testid="sidebar-expand-btn"
		>
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</button>
	{/if}

	<!-- Main content -->
	<!--
	  `padding-right` reserves space for the right-side canvas dock when one
	  is open in the active chat. Without this, DockHost (position: fixed)
	  overlays the chat — the user can't see both. The transition matches
	  the sidebar collapse animation (200ms) for visual consistency, and
	  drops to 0 on mobile where the dock takes the full viewport.
	-->
	<main
		class="relative flex-1 overflow-y-auto {isChatRoute ? 'flex flex-col' : ''}"
		style="padding-right: {reservedDockPx}px; transition: padding-right 200ms ease-in-out;"
		tabindex={isChatRoute ? undefined : 0}
	>
		<!-- Mobile/tablet header (hidden on chat routes - chat has its own header).
		     Visible at `<lg` so tablets get the hamburger too (Phase 49.1).
		     Command Deck: graphite chrome via `data-deck-mobilebar`. -->
		{#if !isChatRoute}
		<div class="flex lg:hidden items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2" data-deck-mobilebar data-testid="mobile-header">
			<button
				onclick={() => (store.mobileMenuOpen = true)}
				class="flex items-center justify-center rounded-sm p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				aria-label="Open menu"
				data-testid="mobile-menu-toggle"
				style="min-width: 44px; min-height: 44px;"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<a href="/" class="min-w-0 flex-1 truncate text-sm font-semibold hover:text-[var(--color-accent)] transition-colors" title="Go to Home" aria-label="Home">{activeProject?.name ?? "EZCorp"}</a>
			<button
				onclick={() => (commandPaletteOpen = true)}
				class="flex items-center justify-center rounded-sm p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				aria-label="Command palette"
				title="Command palette ({metaKey}+K)"
				style="min-width: 44px; min-height: 44px;"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
				</svg>
			</button>
			<ThemeToggle />
			<span
				class="h-2 w-2 rounded-full {store.connected ? 'bg-green-500' : 'bg-red-500'}"
				title={store.connected ? "Connected" : "Disconnected"}
			></span>
		</div>
		{/if}
		<!-- Desktop breadcrumb context strip (≥lg, non-chat routes). -->
		{#if !isChatRoute}
		<div class="hidden lg:flex deck-breadcrumb" data-deck-breadcrumb data-testid="deck-breadcrumb">
			<span class="text-[var(--color-text-muted)]">{isGlobalProject ? "global" : (activeProject?.name ?? "workspace")}</span>
			<span class="deck-breadcrumb__sep">/</span>
			<span class="text-[var(--color-text-secondary)]">{breadcrumbLabel}</span>
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
<DockHost />
<PendingPermissionTray />

<!--
	Ez slide-in panel. The companion EzButton is mounted inside ProjectRail
	(above the "+ Add Project" entry); the panel itself stays at layout
	scope so it overlays every (app) route.
-->
<EzPanel />

<!-- Mobile overlay drawer -->
<SwipeDrawer
	open={store.mobileMenuOpen}
	side="left"
	width="w-[calc(72px+14rem)]"
	maxWidth="max-w-[85vw]"
	onclose={() => (store.mobileMenuOpen = false)}
	ariaLabel="Mobile navigation"
>
	<div class="flex h-full" data-app-rail>
		<ProjectRail />
		<aside class="flex flex-1 flex-col bg-[var(--color-surface-secondary)]" data-deck-mobilebar>
			<div class="flex h-12 items-center gap-2 border-b border-[var(--color-border)] px-3">
				<a href="/" class="min-w-0 flex-1 truncate text-base font-semibold hover:text-[var(--color-accent)] transition-colors" title="Go to Home" aria-label="Home">{activeProject?.name ?? "EZCorp"}</a>
				<span
					class="ml-auto h-2 w-2 rounded-full {store.connected ? 'bg-green-500' : 'bg-red-500'}"
					title={store.connected ? "Connected" : "Disconnected"}
				></span>
				<button
					onclick={() => (store.mobileMenuOpen = false)}
					class="rounded-sm p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)]"
					aria-label="Close menu"
					style="min-width: 44px; min-height: 44px;"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<nav class="scrollbar-hide flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
				{#each navLinks as link, i}
					{#if link.group && (i === 0 || navLinks[i - 1]?.group !== link.group)}
						<div class="deck-section mt-3 mb-1 px-2.5 pt-2 first:mt-0 first:pt-0">
							{link.group}
						</div>
					{/if}
					{@const active = isLinkActive(link.href)}
					{#if link.hub}
						<HubNavSection
							hubBase={link.href}
							currentPath={page.url.pathname}
							{active}
							onnavigate={() => (store.mobileMenuOpen = false)}
						/>
					{:else}
						<a
							href={link.href}
							onclick={() => (store.mobileMenuOpen = false)}
							class="deck-row text-sm"
							style="min-height: 44px; display: flex; align-items: center;"
							aria-current={active ? 'page' : undefined}
						>
							{link.label}
						</a>
					{/if}
				{/each}
			</nav>
		</aside>
	</div>
</SwipeDrawer>

<CommandPalette
	open={commandPaletteOpen}
	initialView={paletteInitialView}
	activeProjectId={store.activeProjectId}
	activeConversationId={activeChatConvId}
	onclose={() => (commandPaletteOpen = false)}
/>

<ShortcutHelp open={shortcutHelpOpen} onclose={() => (shortcutHelpOpen = false)} />

<!-- Global team chat panel (triggered from anywhere via openTeamPanel) -->
<TeamChatPanel />

