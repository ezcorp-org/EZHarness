<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { requireAdmin, type CurrentUser } from "$lib/admin-guard.js";
	import { SETTINGS_DEFAULT_ROUTE } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		scopeOptionsForExtension,
		shapeGrantRow,
		toggleScope,
		validateGrantDraft,
		type PublicGrantView,
	} from "$lib/rbac-grants-logic.js";

	type UserEntry = { id: string; email: string; name: string };
	type ProjectEntry = { id: string; name: string };
	type ExtensionEntry = { id: string; name: string; manifest?: unknown };

	// Page gate: admin-only for now, mirroring /settings/admin. The grants
	// API itself already serves manage-grant holders (server-side row
	// scoping) — opening this page (and its nav entry) to managers is a
	// follow-up; the nav/page gate is UX only, never the security boundary.
	let currentUser = $state<CurrentUser | null>(null);
	let pageLoading = $state(true);

	let grants = $state<PublicGrantView[]>([]);
	let users = $state<UserEntry[]>([]);
	let projects = $state<ProjectEntry[]>([]);
	let extensions = $state<ExtensionEntry[]>([]);
	let loadError = $state(false);

	// Create-form draft. "" on the selects = the covers-all coordinate
	// (sent as null); extension value = manifest slug (the grants FK).
	let draftUserId = $state("");
	let draftProjectId = $state("");
	let draftExtensionId = $state("");
	let draftScopes = $state<string[]>([]);
	let formError = $state<string | null>(null);
	const flash = createSaveFlash();

	// Revoke: two-step confirm (UsersSection force-logout pattern).
	let confirmRevokeId = $state<string | null>(null);
	let revokingId = $state<string | null>(null);
	let revokeError = $state<string | null>(null);

	const selectedExtension = $derived(
		extensions.find((e) => e.name === draftExtensionId) ?? null,
	);
	const scopeOptions = $derived(scopeOptionsForExtension(selectedExtension));
	const rows = $derived(grants.map((g) => shapeGrantRow(g, projects)));

	async function loadGrants() {
		const res = await fetch("/api/rbac/extension-grants");
		if (!res.ok) throw new Error("grants load failed");
		grants = (await res.json()).grants ?? [];
	}

	async function loadAll() {
		try {
			const [usersRes, projectsRes, extensionsRes] = await Promise.all([
				fetch("/api/users"),
				fetch("/api/projects"),
				fetch("/api/extensions"),
			]);
			if (!usersRes.ok || !projectsRes.ok || !extensionsRes.ok) throw new Error("load failed");
			users = (await usersRes.json()).users ?? [];
			projects = (await projectsRes.json()) ?? [];
			extensions = (await extensionsRes.json()) ?? [];
			await loadGrants();
			loadError = false;
		} catch {
			loadError = true;
		}
	}

	// onMount, not $effect — one-shot load (settings locked decision 4).
	onMount(async () => {
		const user = await requireAdmin();
		if (!user) {
			goto(SETTINGS_DEFAULT_ROUTE, { replaceState: true });
			return;
		}
		currentUser = user;
		await loadAll();
		pageLoading = false;
	});

	function onExtensionChange() {
		// A custom scope from the previously selected extension is not
		// grantable at the new coordinates — prune to the fresh option set.
		const options = scopeOptionsForExtension(
			extensions.find((e) => e.name === draftExtensionId) ?? null,
		);
		draftScopes = draftScopes.filter((s) => options.some((o) => o.name === s));
	}

	async function createGrant() {
		formError = validateGrantDraft({ userId: draftUserId, scopes: draftScopes });
		if (formError) return;
		const ok = await flash.run(async () => {
			const res = await fetch("/api/rbac/extension-grants", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					userId: draftUserId,
					projectId: draftProjectId || null,
					extensionId: draftExtensionId || null,
					scopes: draftScopes,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				formError = data.error ?? "Failed to save the grant.";
				throw new Error(formError ?? "save failed");
			}
		});
		if (ok) {
			draftScopes = [];
			await loadGrants().catch(() => {
				loadError = true;
			});
		}
	}

	async function revokeGrant(id: string) {
		revokingId = id;
		revokeError = null;
		try {
			const res = await fetch(`/api/rbac/extension-grants/${id}`, { method: "DELETE" });
			if (res.ok) {
				grants = grants.filter((g) => g.id !== id);
			} else {
				const data = await res.json().catch(() => ({}));
				revokeError = data.error ?? "Failed to revoke the grant.";
			}
		} catch {
			revokeError = "Network error.";
		} finally {
			revokingId = null;
			confirmRevokeId = null;
		}
	}
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<SettingsSection
		id="rbac-grants"
		title="Extension permissions"
		description="Per-project / per-extension scopes for non-admin users. Admins implicitly hold every scope; members are deny-by-default until granted."
	>
		{#if loadError}
			<p class="text-sm text-red-400" data-testid="rbac-load-error">
				Failed to load grants.
				<button onclick={() => loadAll()} class="ml-1 text-blue-400 hover:text-blue-300 transition-colors">Retry</button>
			</p>
		{:else}
			{#if revokeError}
				<p class="mb-3 text-xs text-red-400" data-testid="rbac-revoke-error">{revokeError}</p>
			{/if}
			{#if rows.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]" data-testid="rbac-empty">No grants yet.</p>
			{:else}
				<div class="space-y-2">
					{#each rows as row (row.id)}
						<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2" data-testid="rbac-grant-row">
							<div class="flex flex-wrap items-center gap-2 md:gap-3">
								<div class="flex-1 min-w-0 basis-full md:basis-auto">
									<p class="text-sm text-[var(--color-text-primary)] truncate">{row.userLabel}</p>
									<p class="text-xs text-[var(--color-text-secondary)] truncate">
										{row.projectLabel} · {row.extensionLabel}
									</p>
								</div>
								{#each row.scopes as scope}
									<span class="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]" data-testid="rbac-scope-chip">{scope}</span>
								{/each}
								{#if confirmRevokeId === row.id}
									<span class="text-xs text-yellow-400">Revoke?</span>
									<button
										onclick={() => revokeGrant(row.id)}
										disabled={revokingId === row.id}
										data-testid="rbac-revoke-confirm"
										class="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
									>
										{revokingId === row.id ? "Revoking..." : "Yes"}
									</button>
									<button
										onclick={() => { confirmRevokeId = null; }}
										class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
									>
										No
									</button>
								{:else}
									<button
										onclick={() => { confirmRevokeId = row.id; }}
										data-testid="rbac-revoke"
										class="text-xs text-red-400 hover:text-red-300 transition-colors"
									>
										Revoke
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</SettingsSection>

	<SettingsSection
		id="rbac-create"
		title="Grant scopes"
		description="Grant a user scopes on a project and extension. Leave a select on “All” for a grant covering every project / extension."
	>
		<div class="grid gap-3 md:grid-cols-3">
			<label class="block text-xs text-[var(--color-text-secondary)]">
				User
				<select
					bind:value={draftUserId}
					data-testid="rbac-user-select"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					<option value="">Select a user…</option>
					{#each users as u (u.id)}
						<option value={u.id}>{u.email}</option>
					{/each}
				</select>
			</label>
			<label class="block text-xs text-[var(--color-text-secondary)]">
				Project
				<select
					bind:value={draftProjectId}
					data-testid="rbac-project-select"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					<option value="">All projects</option>
					{#each projects as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</select>
			</label>
			<label class="block text-xs text-[var(--color-text-secondary)]">
				Extension
				<select
					bind:value={draftExtensionId}
					onchange={onExtensionChange}
					data-testid="rbac-extension-select"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					<option value="">All extensions</option>
					{#each extensions as e (e.name)}
						<option value={e.name}>{e.name}</option>
					{/each}
				</select>
			</label>
		</div>

		<fieldset class="mt-3">
			<legend class="text-xs text-[var(--color-text-secondary)]">Scopes</legend>
			<div class="mt-1 flex flex-wrap gap-2">
				{#each scopeOptions as option (option.name)}
					<label
						class="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
						title={option.description}
					>
						<input
							type="checkbox"
							checked={draftScopes.includes(option.name)}
							onchange={() => { draftScopes = toggleScope(draftScopes, option.name); }}
							data-testid="rbac-scope-{option.name}"
						/>
						{option.name}
						{#if option.custom}
							<span class="rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5 text-[10px] text-[var(--color-text-secondary)]">custom</span>
						{/if}
					</label>
				{/each}
			</div>
		</fieldset>

		{#if formError}
			<p class="mt-2 text-xs text-red-400" data-testid="rbac-form-error">{formError}</p>
		{/if}
		<div class="mt-3 flex items-center gap-3">
			<button
				onclick={createGrant}
				disabled={flash.saving}
				data-testid="rbac-create"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
			>
				Grant
			</button>
			<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
		</div>
	</SettingsSection>
{/if}
