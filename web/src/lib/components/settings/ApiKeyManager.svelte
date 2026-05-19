<script lang="ts">
	const SCOPES = ["read", "chat", "extensions", "admin"] as const;

	type ApiKeyEntry = { keyId: string; name: string; scopes: string[]; createdAt: number };

	let keys = $state<ApiKeyEntry[]>([]);
	let loading = $state(true);
	let creating = $state(false);
	let newKeyName = $state("");
	let selectedScopes = $state<Set<string>>(new Set(["read"]));
	let revealedKey = $state<string | null>(null);
	let confirmRevokeId = $state<string | null>(null);
	let copied = $state(false);

	async function loadKeys() {
		loading = true;
		try {
			const res = await fetch("/api/settings/developer/api-keys");
			if (res.ok) {
				const data = await res.json();
				keys = data.keys;
			}
		} catch { /* silent */ }
		loading = false;
	}

	async function createKey() {
		if (!newKeyName.trim() || selectedScopes.size === 0) return;
		creating = true;
		try {
			const res = await fetch("/api/settings/developer/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: newKeyName.trim(), scopes: [...selectedScopes] }),
			});
			if (res.ok) {
				const data = await res.json();
				revealedKey = data.key;
				newKeyName = "";
				selectedScopes = new Set(["read"]);
				await loadKeys();
			}
		} catch { /* silent */ }
		creating = false;
	}

	async function revokeKey(keyId: string) {
		const res = await fetch("/api/settings/developer/api-keys", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId }),
		});
		if (res.ok || res.status === 204) {
			confirmRevokeId = null;
			await loadKeys();
		}
	}

	function toggleScope(scope: string) {
		const next = new Set(selectedScopes);
		if (next.has(scope)) next.delete(scope);
		else next.add(scope);
		selectedScopes = next;
	}

	function copyKey() {
		if (revealedKey) {
			navigator.clipboard.writeText(revealedKey);
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		}
	}

	$effect(() => { loadKeys(); });
</script>

<!-- Revealed key banner -->
{#if revealedKey}
	<div class="mb-4 rounded-lg border border-amber-700 bg-amber-950 p-4">
		<p class="mb-2 text-sm font-medium text-amber-300">This key will only be shown once. Copy it now.</p>
		<div class="flex items-center gap-2">
			<code class="flex-1 rounded bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-primary)] font-mono break-all select-all">{revealedKey}</code>
			<button onclick={copyKey} class="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 transition-colors">
				{copied ? "Copied!" : "Copy"}
			</button>
		</div>
		<button onclick={() => { revealedKey = null; }} class="mt-2 text-xs text-amber-400 hover:text-amber-300 transition-colors">Dismiss</button>
	</div>
{/if}

<!-- Existing keys -->
{#if loading}
	<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
{:else if keys.length === 0}
	<p class="text-sm text-[var(--color-text-secondary)]">No API keys yet.</p>
{:else}
	<div class="mb-4 space-y-2">
		{#each keys as key}
			<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
				<div class="flex-1 min-w-0">
					<p class="text-sm text-[var(--color-text-primary)] truncate">{key.name}</p>
					<div class="flex items-center gap-1 mt-1">
						{#each key.scopes as scope}
							<span class="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]">{scope}</span>
						{/each}
						<span class="text-xs text-[var(--color-text-muted)] ml-2">{new Date(key.createdAt).toLocaleDateString()}</span>
					</div>
				</div>
				{#if confirmRevokeId === key.keyId}
					<span class="text-xs text-[var(--color-text-secondary)]">Confirm?</span>
					<button onclick={() => revokeKey(key.keyId)} class="text-xs text-red-400 hover:text-red-300 transition-colors">Yes, revoke</button>
					<button onclick={() => { confirmRevokeId = null; }} class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">Cancel</button>
				{:else}
					<button onclick={() => { confirmRevokeId = key.keyId; }} class="text-xs text-red-400 hover:text-red-300 transition-colors">Revoke</button>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<!-- Create new key -->
<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
	<h4 class="mb-3 text-sm font-medium text-[var(--color-text-primary)]">Create API Key</h4>
	<div class="space-y-3">
		<div>
			<label for="api-key-manager-name" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Name</label>
			<input
				id="api-key-manager-name"
				type="text"
				bind:value={newKeyName}
				placeholder="e.g. CI Pipeline"
				class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>
		<div>
			<div class="mb-1 block text-xs text-[var(--color-text-secondary)]">Scopes</div>
			<div class="flex flex-wrap gap-2">
				{#each SCOPES as scope}
					<button
						onclick={() => toggleScope(scope)}
						class="rounded-md px-3 py-1 text-xs font-medium transition-colors
							{selectedScopes.has(scope)
								? 'bg-blue-600 text-white'
								: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
					>
						{scope}
					</button>
				{/each}
			</div>
		</div>
		<button
			onclick={createKey}
			disabled={creating || !newKeyName.trim() || selectedScopes.size === 0}
			class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{creating ? "Creating..." : "Create API Key"}
		</button>
	</div>
</div>
