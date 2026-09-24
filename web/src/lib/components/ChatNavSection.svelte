<!--
  ChatNavSection — the sidebar's collapsible "Chat" entry.

  The chat threads used to live in a second, 280px column beside the sidebar
  on every conversation page. They live here now, in the sidebar the user is
  already looking at, and the conversation gets that width back.

  Same shape as HubNavSection, deliberately: a disclosure caret that toggles,
  a label that links to the section's index (here the all-chats page, which
  keeps the full list — search, rename, delete, paging), and an `onnavigate`
  hook the mobile drawer uses to close itself.

  Shows only the most RECENT few threads, then an "All chats" link. A sidebar
  is a menu first: listing every thread would push Hub, Agents and the rest of
  the navigation off the bottom for anyone with a long history.

  That link is ALWAYS shown, not only when threads overflow: the all-chats
  page is also where search, rename and delete live, and the Chat label
  deliberately jumps to your last chat instead. Gating it on "more than N
  chats" left those unreachable from the UI for anyone with a short history.

  Stays current through two window events, and holds no reference to any
  other list:
    - `conversation:created` — a server-created thread (the daily briefing);
    - `conversations:changed` — a thread was created, renamed, deleted, or
      titled anywhere in the app (see notifyConversationsChanged).
-->
<script lang="ts">
	import { goto } from "$app/navigation";
	import { createConversation, fetchConversations, type Conversation } from "$lib/api.js";
	import { groupConversations, type ConversationGroup } from "$lib/conversation-grouping.js";
	import { CONVERSATIONS_CHANGED, notifyConversationsChanged, refreshQuickstart } from "$lib/stores.svelte.js";
	import { unreadStore } from "$lib/unread.js";

	let {
		chatBase,
		projectId,
		currentPath,
		active = false,
		onnavigate,
	}: {
		/** "/project/<id>/chat" — the all-chats page; threads live beneath it. */
		chatBase: string;
		/** The project whose threads to list ("global" for the workspace). */
		projectId: string;
		/** The current pathname — drives the active highlight on each thread. */
		currentPath: string;
		/** True anywhere under the chat routes; also opens the section by default. */
		active?: boolean;
		/** Invoked after navigating — the mobile drawer uses it to close itself. */
		onnavigate?: () => void;
	} = $props();

	/** How many threads the sidebar shows before the "All chats" link. */
	const CHAT_NAV_RECENT_LIMIT = 8;
	const STORAGE_KEY = "ezcorp:chat-nav-expanded";

	// An explicit choice (either way) wins and is remembered. With no choice
	// on record the section is open while you are in Chat and closed elsewhere.
	function storedPreference(): boolean | null {
		try {
			const v = localStorage.getItem(STORAGE_KEY);
			return v === null ? null : v === "1";
		} catch {
			return null;
		}
	}
	let preference = $state<boolean | null>(storedPreference());
	let expanded = $derived(preference ?? active);

	let conversations = $state<Conversation[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let creating = $state(false);
	let unreadRev = $state(0);

	$effect(() => unreadStore.subscribe(() => { unreadRev++; }));

	async function load() {
		const requestedFor = projectId;
		loading = true;
		try {
			const page = await fetchConversations(requestedFor, { limit: CHAT_NAV_RECENT_LIMIT, offset: 0 });
			// A project switch mid-flight must not paint the old project's threads.
			if (requestedFor !== projectId) return;
			conversations = page;
		} catch {
			// Degrade silently — the Chat label still links to the full list.
		} finally {
			loading = false;
			loaded = true;
		}
	}

	// Load when first opened, and again whenever the project changes while open.
	$effect(() => {
		void projectId;
		if (expanded) void load();
	});

	$effect(() => {
		const current = projectId;
		function onChanged(e: Event) {
			const target = (e as CustomEvent<{ projectId?: string } | undefined>).detail?.projectId;
			if (target !== undefined && target !== current) return;
			// Collapsed, the next open fetches fresh anyway.
			if (expanded) void load();
			else loaded = false;
		}
		window.addEventListener(CONVERSATIONS_CHANGED, onChanged);
		window.addEventListener("conversation:created", onChanged);
		return () => {
			window.removeEventListener(CONVERSATIONS_CHANGED, onChanged);
			window.removeEventListener("conversation:created", onChanged);
		};
	});

	function toggle() {
		preference = !expanded;
		try {
			localStorage.setItem(STORAGE_KEY, preference ? "1" : "0");
		} catch {
			// Private mode / blocked storage: the toggle still works this session.
		}
	}

	async function newChat() {
		if (creating) return;
		creating = true;
		try {
			const conv = await createConversation({ projectId });
			void refreshQuickstart();
			notifyConversationsChanged(projectId);
			onnavigate?.();
			await goto(`${chatBase}/${conv.id}`);
		} catch (err) {
			console.error("Failed to create conversation:", err);
		} finally {
			creating = false;
		}
	}

	// Families (a thread plus its forks) bucketed by recency, the same grouping
	// the full list uses — so "Today" means the same thing in both places.
	// Each family renders as its root plus its forks, indented: a fork you just
	// made must be visible (and highlighted while you are on it), not hidden
	// inside its parent. Every row, root or fork, counts against the cap.
	type Row = { conv: Conversation; fork: boolean };
	let groups = $derived.by((): { label: string; rows: Row[] }[] => {
		const all: ConversationGroup[] = groupConversations(conversations, { now: Date.now() });
		let budget = CHAT_NAV_RECENT_LIMIT;
		const out: { label: string; rows: Row[] }[] = [];
		for (const group of all) {
			if (budget <= 0) break;
			const rows: Row[] = [];
			for (const fam of group.families) {
				if (budget <= 0) break;
				rows.push({ conv: fam.root, fork: false });
				budget--;
				for (const fork of fam.forks.slice(0, budget)) {
					rows.push({ conv: fork, fork: true });
					budget--;
				}
			}
			out.push({ label: group.label, rows });
		}
		return out;
	});

	function threadHref(id: string): string {
		return `${chatBase}/${encodeURIComponent(id)}`;
	}

	function isThreadActive(id: string): boolean {
		return currentPath === threadHref(id);
	}

	function titleOf(conv: Conversation): string {
		return conv.title?.trim() || "New conversation";
	}
</script>

<div data-testid="chat-nav-section">
	<!-- Index row: caret toggles; the label opens the all-chats page; + starts a thread. -->
	<div class="deck-row" aria-current={active ? "page" : undefined}>
		<button
			type="button"
			class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[var(--color-text-muted)] transition-transform duration-150 hover:text-[var(--color-text-primary)] {expanded
				? 'rotate-90'
				: ''}"
			aria-expanded={expanded}
			aria-controls="chat-nav-threads"
			aria-label={expanded ? "Collapse chat threads" : "Expand chat threads"}
			data-testid="chat-nav-toggle"
			onclick={toggle}
		>
			<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</button>
		<a href={chatBase} class="min-w-0 flex-1 truncate" data-testid="chat-nav-link" onclick={() => onnavigate?.()}>
			Chat
		</a>
		<button
			type="button"
			class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
			aria-label="New chat"
			title="New chat"
			data-testid="chat-nav-new"
			disabled={creating}
			onclick={newChat}
		>
			<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14M5 12h14" />
			</svg>
		</button>
	</div>

	{#if expanded}
		<div id="chat-nav-threads" class="mt-0.5" data-testid="chat-nav-threads">
			{#if loading && !loaded}
				<p class="px-2.5 py-1 pl-8 text-xs text-[var(--color-text-muted)]" data-testid="chat-nav-loading">Loading…</p>
			{:else if groups.length === 0}
				<p class="px-2.5 py-1 pl-8 text-xs text-[var(--color-text-muted)]" data-testid="chat-nav-empty">No chats yet</p>
			{:else}
				{#each groups as group (group.label)}
					<p
						class="px-2.5 pt-1.5 pb-0.5 pl-8 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]"
						data-testid="chat-nav-group"
					>
						{group.label}
					</p>
					<ul class="flex flex-col gap-0.5" aria-label={`${group.label} chats`}>
						{#each group.rows as row (row.conv.id)}
							{@const threadActive = isThreadActive(row.conv.id)}
							<li>
								<a
									href={threadHref(row.conv.id)}
									class="deck-row"
									style="padding-left: {row.fork ? '2.75rem' : '1.75rem'};"
									data-testid="chat-nav-thread"
									data-conversation-id={row.conv.id}
									data-fork={row.fork ? "true" : undefined}
									aria-current={threadActive ? "page" : undefined}
									onclick={() => onnavigate?.()}
								>
									{#if row.fork}
										<span class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">↳</span>
									{/if}
									<span class="truncate">{titleOf(row.conv)}</span>
									{#if !threadActive && unreadRev >= 0 && unreadStore.isUnread(row.conv.id)}
										<span
											class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
											data-testid="chat-nav-unread"
											aria-label="Unread"
										></span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/each}
				<a
					href={`${chatBase}?all=1`}
					class="deck-row text-xs text-[var(--color-text-muted)]"
					style="padding-left: 1.75rem;"
					data-testid="chat-nav-show-all"
					onclick={() => onnavigate?.()}
				>
					All chats →
				</a>
			{/if}
		</div>
	{/if}
</div>
