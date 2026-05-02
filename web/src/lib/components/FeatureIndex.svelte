<script lang="ts">
	import { untrack } from "svelte";
	import { searchMentions } from "$lib/api";

	/**
	 * Per-project Feature Index settings UI.
	 *
	 * Mounted on /project/[id]/settings. Surfaces the
	 * `/api/projects/:id/features` endpoint family:
	 *   - GET   /                  (list)
	 *   - POST  /                  (create user-sourced feature)
	 *   - PATCH /:featureId        (rename, edit description, add/remove pins)
	 *   - DELETE /:featureId       (drop feature + cascaded files)
	 *   - POST  /scan              (synchronous FS walk, upserts agent rows)
	 *
	 * The `+ Add file` picker reuses the `@[file:…]` autocomplete via the
	 * existing `searchMentions(query, "path", projectId)` helper so we
	 * don't reinvent the symlink-escape filter at the UI layer.
	 */

	interface FeatureFileRow {
		featureId: string;
		relpath: string;
		source: "user" | "scan";
		addedAt: string;
	}

	interface FeatureRow {
		id: string;
		projectId: string;
		name: string;
		description: string;
		source: "user" | "agent";
		fileCount: number;
		createdAt: string;
		updatedAt: string;
		// Populated lazily on row expand via GET /api/projects/:id/features
		// (the list endpoint embeds counts only; the per-feature file list
		// comes from a fresh PATCH-empty call OR the per-PATCH response
		// `files` shape — we pull via the PATCH echo on add/remove).
		files?: FeatureFileRow[];
	}

	let { projectId }: { projectId: string } = $props();

	let features = $state<FeatureRow[]>([]);
	let loading = $state(false);
	let scanning = $state(false);
	let creating = $state(false);
	let searchQuery = $state("");
	let expandedId = $state<string | null>(null);

	// Inline-edit state (one row at a time).
	let editingId = $state<string | null>(null);
	let editName = $state("");
	let editDescription = $state("");

	// New-feature form state.
	let newFeatureOpen = $state(false);
	let newFeatureName = $state("");
	let newFeatureDescription = $state("");

	// Add-file picker state per expanded feature.
	let addFileQuery = $state("");
	let addFileResults = $state<Array<{ name: string; description: string; kind: string }>>([]);
	let addFileFeatureId = $state<string | null>(null);

	// Surface API error to the user without a toast system — inline banner.
	let errorMessage = $state<string | null>(null);

	let filtered = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return features;
		return features.filter(
			(f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q),
		);
	});

	async function fetchFeatures(): Promise<void> {
		loading = features.length === 0;
		try {
			const res = await fetch(`/api/projects/${projectId}/features`);
			if (res.ok) {
				features = await res.json();
			} else {
				errorMessage = `Failed to load features (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Failed to load features: ${String(e)}`;
		} finally {
			loading = false;
		}
	}

	async function handleScan(): Promise<void> {
		scanning = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features/scan`, { method: "POST" });
			if (res.ok) {
				features = await res.json();
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Scan failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Scan failed: ${String(e)}`;
		} finally {
			scanning = false;
		}
	}

	async function handleCreate(): Promise<void> {
		const name = newFeatureName.trim();
		if (!name) return;
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name,
					description: newFeatureDescription.trim() || undefined,
				}),
			});
			if (res.ok) {
				const created: FeatureRow = await res.json();
				features = [...features, created].sort((a, b) => a.name.localeCompare(b.name));
				newFeatureName = "";
				newFeatureDescription = "";
				newFeatureOpen = false;
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Create failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Create failed: ${String(e)}`;
		} finally {
			creating = false;
		}
	}

	function startEdit(f: FeatureRow): void {
		editingId = f.id;
		editName = f.name;
		editDescription = f.description;
	}

	async function commitEdit(f: FeatureRow): Promise<void> {
		if (editingId !== f.id) return;
		const name = editName.trim();
		const description = editDescription;
		// Skip the round trip when nothing changed.
		if (name === f.name && description === f.description) {
			editingId = null;
			return;
		}
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features/${f.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name, description }),
			});
			if (res.ok) {
				const updated = await res.json();
				features = features
					.map((x) => (x.id === f.id ? { ...x, ...updated } : x))
					.sort((a, b) => a.name.localeCompare(b.name));
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Save failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Save failed: ${String(e)}`;
		} finally {
			editingId = null;
		}
	}

	async function handleDelete(f: FeatureRow): Promise<void> {
		if (!confirm(`Delete feature "${f.name}"? This drops every file row associated with it.`)) return;
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features/${f.id}`, {
				method: "DELETE",
			});
			if (res.ok) {
				features = features.filter((x) => x.id !== f.id);
				if (expandedId === f.id) expandedId = null;
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Delete failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Delete failed: ${String(e)}`;
		}
	}

	async function toggleExpand(f: FeatureRow): Promise<void> {
		if (expandedId === f.id) {
			expandedId = null;
			return;
		}
		expandedId = f.id;
		// Fetching files: we PATCH with no-op to get the file list back —
		// the list endpoint only returns counts. A dedicated GET-by-id
		// endpoint would be cleaner; for now this avoids a fourth route.
		// Skip if we already loaded files in a prior session.
		if (f.files !== undefined) return;
		await refreshFeatureFiles(f.id);
	}

	async function refreshFeatureFiles(featureId: string): Promise<void> {
		try {
			// Empty PATCH would 400 (zod refine requires a field). Send a
			// description-rewrite to its current value instead — a no-op
			// from the user's perspective. The endpoint echoes the row +
			// files array.
			const target = features.find((x) => x.id === featureId);
			if (!target) return;
			const res = await fetch(`/api/projects/${projectId}/features/${featureId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ description: target.description }),
			});
			if (res.ok) {
				const updated = (await res.json()) as FeatureRow & { files: FeatureFileRow[] };
				features = features.map((x) =>
					x.id === featureId ? { ...x, ...updated, files: updated.files } : x,
				);
			}
		} catch {
			// silent — expand UI just shows "no files"
		}
	}

	async function removeFile(featureId: string, relpath: string): Promise<void> {
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features/${featureId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ removeFiles: [relpath] }),
			});
			if (res.ok) {
				const updated = (await res.json()) as FeatureRow & { files: FeatureFileRow[] };
				features = features.map((x) =>
					x.id === featureId ? { ...x, ...updated, files: updated.files } : x,
				);
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Remove failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Remove failed: ${String(e)}`;
		}
	}

	async function addFile(featureId: string, relpath: string): Promise<void> {
		errorMessage = null;
		try {
			const res = await fetch(`/api/projects/${projectId}/features/${featureId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ addFiles: [relpath] }),
			});
			if (res.ok) {
				const updated = (await res.json()) as FeatureRow & { files: FeatureFileRow[] };
				features = features.map((x) =>
					x.id === featureId ? { ...x, ...updated, files: updated.files } : x,
				);
			} else {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMessage = body.error ?? `Add failed (HTTP ${res.status})`;
			}
		} catch (e) {
			errorMessage = `Add failed: ${String(e)}`;
		} finally {
			addFileQuery = "";
			addFileResults = [];
		}
	}

	async function refreshAddFileResults(featureId: string): Promise<void> {
		addFileFeatureId = featureId;
		const q = addFileQuery.trim();
		if (!q) {
			addFileResults = [];
			return;
		}
		try {
			// Reuse the @[file:…] autocomplete — same project-scoped
			// filesystem walker, same symlink-escape rules.
			addFileResults = await searchMentions(q, "path", projectId);
		} catch {
			addFileResults = [];
		}
	}

	$effect(() => {
		// Track projectId so the effect re-fires when the user navigates
		// between projects in the same session. `fetchFeatures()` itself
		// reads `features.length` (for the loading-flag heuristic) and
		// then writes `features = await res.json()` — without `untrack`
		// that synchronous read subscribes the effect to its own write
		// target, producing an unbounded re-fetch loop the moment the
		// fetch resolves. `untrack` confines reactivity to projectId
		// only, which is the only dependency we actually want here.
		void projectId;
		untrack(() => fetchFeatures());
	});
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-3">
		<h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Feature Index</h3>
		<div class="flex items-center gap-2">
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search features..."
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
			<button
				onclick={() => (newFeatureOpen = !newFeatureOpen)}
				class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
			>
				+ New feature
			</button>
			<button
				onclick={handleScan}
				disabled={scanning}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				{scanning ? "Scanning..." : "Scan features"}
			</button>
		</div>
	</div>

	{#if errorMessage}
		<div class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
			{errorMessage}
		</div>
	{/if}

	{#if newFeatureOpen}
		<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
			<input
				type="text"
				bind:value={newFeatureName}
				placeholder="Feature name (e.g. chat-attachments)"
				class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
			<textarea
				bind:value={newFeatureDescription}
				rows={2}
				placeholder="Optional description"
				class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
			></textarea>
			<div class="flex justify-end gap-2">
				<button
					onclick={() => {
						newFeatureOpen = false;
						newFeatureName = "";
						newFeatureDescription = "";
					}}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={handleCreate}
					disabled={creating || !newFeatureName.trim()}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
				>
					{creating ? "Creating..." : "Create"}
				</button>
			</div>
		</div>
	{/if}

	{#if loading}
		<div class="text-sm text-[var(--color-text-muted)]">Loading features...</div>
	{:else if filtered.length === 0}
		<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
			{#if features.length === 0}
				No features yet. Click <strong>Scan features</strong> to auto-populate from this project's source roots, or
				<strong>+ New feature</strong> to create one manually.
			{:else}
				No features match "{searchQuery}".
			{/if}
		</div>
	{:else}
		<div class="overflow-x-auto rounded-md border border-[var(--color-border)]">
			<table class="w-full text-sm text-left">
				<thead class="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
					<tr>
						<th class="px-3 py-2 font-medium w-8"></th>
						<th class="px-3 py-2 font-medium">Name</th>
						<th class="px-3 py-2 font-medium">Description</th>
						<th class="px-3 py-2 font-medium w-20 text-right">Files</th>
						<th class="px-3 py-2 font-medium w-20">Source</th>
						<th class="px-3 py-2 font-medium w-32 text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as f (f.id)}
						<tr class="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-secondary)]">
							<td class="px-3 py-2 align-top">
								<button
									aria-label={expandedId === f.id ? "Collapse" : "Expand"}
									onclick={() => toggleExpand(f)}
									class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								>
									{expandedId === f.id ? "▾" : "▸"}
								</button>
							</td>
							<td class="px-3 py-2 align-top font-mono text-[var(--color-text-primary)]">
								{#if editingId === f.id}
									<input
										type="text"
										bind:value={editName}
										onblur={() => commitEdit(f)}
										class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm font-mono"
									/>
								{:else}
									<button
										onclick={() => startEdit(f)}
										class="text-left hover:underline"
										aria-label="Edit name"
									>
										{f.name}
									</button>
								{/if}
							</td>
							<td class="px-3 py-2 align-top text-[var(--color-text-secondary)]">
								{#if editingId === f.id}
									<textarea
										bind:value={editDescription}
										onblur={() => commitEdit(f)}
										rows={1}
										class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm resize-y"
									></textarea>
								{:else}
									<button
										onclick={() => startEdit(f)}
										class="text-left hover:underline"
										aria-label="Edit description"
									>
										{f.description || "—"}
									</button>
								{/if}
							</td>
							<td class="px-3 py-2 align-top text-right text-[var(--color-text-secondary)]">
								{f.fileCount}
							</td>
							<td class="px-3 py-2 align-top">
								<span
									class="rounded-md px-1.5 py-0.5 text-xs"
									class:bg-blue-500={f.source === "user"}
									class:bg-blue-500-bg={f.source === "user"}
									class:text-blue-300={f.source === "user"}
									class:text-amber-300={f.source === "agent"}
								>
									{f.source}
								</span>
							</td>
							<td class="px-3 py-2 align-top text-right">
								<button
									onclick={() => handleDelete(f)}
									class="rounded-md px-2 py-0.5 text-xs text-red-400 hover:bg-[var(--color-surface-tertiary)] hover:text-red-300"
								>
									Delete
								</button>
							</td>
						</tr>
						{#if expandedId === f.id}
							<tr class="border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
								<td colspan="6" class="px-6 py-3">
									{#if !f.files}
										<div class="text-xs text-[var(--color-text-muted)]">Loading files...</div>
									{:else if f.files.length === 0}
										<div class="text-xs text-[var(--color-text-muted)]">No files yet — use the picker below to pin one.</div>
									{:else}
										<ul class="space-y-1">
											{#each f.files as file (file.relpath)}
												<li class="flex items-center gap-2 text-xs">
													<span
														class="rounded px-1.5 py-0.5 font-mono text-[10px]"
														class:text-amber-300={file.source === "scan"}
														class:text-blue-300={file.source === "user"}
													>
														{file.source === "user" ? "pin" : "scan"}
													</span>
													<span class="font-mono text-[var(--color-text-primary)]">{file.relpath}</span>
													<button
														aria-label="Remove file"
														onclick={() => removeFile(f.id, file.relpath)}
														class="ml-auto text-[var(--color-text-muted)] hover:text-red-400"
													>
														×
													</button>
												</li>
											{/each}
										</ul>
									{/if}
									<!-- Add-file picker reusing @[file:…] autocomplete via searchMentions(type="path"). -->
									<div class="mt-3 flex flex-col gap-1">
										<input
											type="text"
											bind:value={addFileQuery}
											oninput={() => refreshAddFileResults(f.id)}
											onfocus={() => (addFileFeatureId = f.id)}
											placeholder="+ Add file (search project paths)"
											class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
										/>
										{#if addFileFeatureId === f.id && addFileResults.length > 0}
											<ul class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] max-h-48 overflow-y-auto">
												{#each addFileResults as r (r.name)}
													<li>
														<button
															onclick={() => addFile(f.id, r.name)}
															class="block w-full text-left px-2 py-1 text-xs font-mono text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)]"
														>
															<span class="text-[var(--color-text-muted)]">[{r.kind}]</span>
															{r.name}
														</button>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
