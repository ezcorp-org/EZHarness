<script lang="ts">
	import { store } from "$lib/stores.svelte.js";
	import { addToast } from "$lib/toast.svelte.js";
	import {
		importPreview,
		importCommit,
		deleteUserCommand,
		uninstallExtension,
		type ImportPreviewResult,
		type ImportItemResult,
	} from "$lib/api.js";

	type Step = 1 | 2 | 3;
	let step = $state<Step>(1);
	let busy = $state(false);
	let errorMsg = $state("");

	// Project selection — imports install under a concrete project.
	let projectId = $state(
		store.activeProjectId && store.activeProjectId !== "global"
			? store.activeProjectId
			: (store.projects[0]?.id ?? ""),
	);

	// store.projects loads async (layout fetch) — adopt a project once
	// it arrives if we didn't already have one.
	$effect(() => {
		if (!projectId && store.projects.length > 0) {
			projectId =
				store.activeProjectId && store.activeProjectId !== "global"
					? store.activeProjectId
					: store.projects[0]!.id;
		}
	});

	let preview = $state<ImportPreviewResult | null>(null);
	let selectedCommands = $state<Record<string, boolean>>({});
	let selectedSkills = $state<Record<string, boolean>>({});
	let results = $state<ImportItemResult[]>([]);

	let dirInput = $state<HTMLInputElement>();
	let archiveInput = $state<HTMLInputElement>();

	function dirAttr(node: HTMLInputElement) {
		node.setAttribute("webkitdirectory", "");
		node.setAttribute("directory", "");
	}

	async function runPreview(form: FormData) {
		if (!projectId) {
			errorMsg = "Select a project first — imports install under a project.";
			return;
		}
		form.append("projectId", projectId);
		busy = true;
		errorMsg = "";
		try {
			preview = await importPreview(form);
			selectedCommands = Object.fromEntries(
				preview.commands.map((c) => [c.id, true]),
			);
			selectedSkills = Object.fromEntries(
				preview.skills.map((s) => [s.id, true]),
			);
			if (preview.commands.length === 0 && preview.skills.length === 0) {
				errorMsg =
					"Nothing importable found — expected .claude/.codex/agents commands or .claude/skills bundles.";
			} else {
				step = 2;
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Preview failed";
		} finally {
			busy = false;
		}
	}

	async function onDirPick() {
		const files = Array.from(dirInput?.files ?? []);
		if (files.length === 0) return;
		const form = new FormData();
		for (const f of files) {
			form.append("files", f);
			form.append("paths", f.webkitRelativePath || f.name);
		}
		await runPreview(form);
	}

	async function onArchivePick() {
		const file = archiveInput?.files?.[0];
		if (!file) return;
		const form = new FormData();
		form.append("archive", file);
		await runPreview(form);
	}

	async function commit() {
		if (!preview) return;
		busy = true;
		errorMsg = "";
		try {
			const res = await importCommit({
				sessionId: preview.sessionId,
				projectId,
				commands: preview.commands
					.filter((c) => selectedCommands[c.id])
					.map((c) => c.id),
				skills: preview.skills
					.filter((s) => selectedSkills[s.id])
					.map((s) => s.id),
			});
			results = res.results;
			step = 3;
			const ok = results.filter((r) => r.status === "ok").length;
			const bad = results.filter((r) => r.status === "error").length;
			addToast({
				type: bad ? "warning" : "success",
				message: `Imported ${ok} item${ok === 1 ? "" : "s"}${bad ? `, ${bad} failed` : ""}`,
			});
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Import failed";
		} finally {
			busy = false;
		}
	}

	async function removeItem(r: ImportItemResult) {
		try {
			if (r.kind === "command" && r.finalName) {
				await deleteUserCommand(r.finalName);
			} else if (r.kind === "skill" && r.extId) {
				await uninstallExtension(r.extId);
			}
			results = results.map((x) =>
				x === r ? { ...x, status: "error", message: "removed" } : x,
			);
			addToast({ type: "success", message: `Removed ${r.finalName ?? r.requested}` });
		} catch (e) {
			addToast({
				type: "error",
				message: e instanceof Error ? e.message : "Remove failed",
			});
		}
	}

	async function undoAll() {
		const ok = results.filter((r) => r.status === "ok");
		for (const r of ok) await removeItem(r);
	}

	function reset() {
		step = 1;
		preview = null;
		results = [];
		errorMsg = "";
		if (dirInput) dirInput.value = "";
		if (archiveInput) archiveInput.value = "";
	}

	const okResults = $derived(results.filter((r) => r.status === "ok"));
</script>

<div class="space-y-6" data-testid="import-wizard" data-step={step}>
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">
			Import skills &amp; commands
		</h2>
		{#if step !== 1}
			<button
				class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
				onclick={reset}
				data-testid="import-restart"
			>
				Start over
			</button>
		{/if}
	</div>

	<p class="max-w-2xl text-sm text-[var(--color-text-muted)]">
		Bring in your existing Claude / Codex slash-commands, prompts and agents,
		plus Claude <strong>skill bundles</strong> (these install as runnable, but
		<em>disabled</em>, extensions — review &amp; enable them afterwards).
		Pick the folder that contains <code>.claude</code> / <code>.codex</code>,
		or upload a zip / tar.gz. Nothing is one-way: everything imported can be
		removed from this screen or its normal management page.
	</p>

	{#if errorMsg}
		<div
			class="rounded-lg bg-red-900/40 px-4 py-2 text-sm text-red-400"
			data-testid="import-error"
		>
			{errorMsg}
		</div>
	{/if}

	{#if step === 1}
		<div class="space-y-4">
			<label class="block text-sm text-[var(--color-text-secondary)]">
				Import into project
				<select
					class="mt-1 block w-full max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
					bind:value={projectId}
					data-testid="import-project"
				>
					{#if store.projects.length === 0}
						<option value="">No projects available</option>
					{/if}
					{#each store.projects as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</select>
			</label>

			<div class="grid gap-4 sm:grid-cols-2">
				<div
					class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
				>
					<h3 class="mb-1 text-sm font-medium text-[var(--color-text-primary)]">
						Pick a folder
					</h3>
					<p class="mb-3 text-xs text-[var(--color-text-muted)]">
						Select your <code>.claude</code> folder (or its parent).
					</p>
					<input
						bind:this={dirInput}
						use:dirAttr
						type="file"
						multiple
						onchange={onDirPick}
						disabled={busy}
						data-testid="import-dir-input"
						class="text-sm text-[var(--color-text-secondary)]"
					/>
				</div>
				<div
					class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
				>
					<h3 class="mb-1 text-sm font-medium text-[var(--color-text-primary)]">
						Upload an archive
					</h3>
					<p class="mb-3 text-xs text-[var(--color-text-muted)]">
						A <code>.zip</code>, <code>.tar.gz</code> or <code>.tgz</code>.
					</p>
					<input
						bind:this={archiveInput}
						type="file"
						accept=".zip,.tar.gz,.tgz"
						onchange={onArchivePick}
						disabled={busy}
						data-testid="import-archive-input"
						class="text-sm text-[var(--color-text-secondary)]"
					/>
				</div>
			</div>
			{#if busy}
				<p class="text-sm text-[var(--color-text-muted)]" data-testid="import-busy">
					Scanning upload…
				</p>
			{/if}
		</div>
	{/if}

	{#if step === 2 && preview}
		<div class="space-y-6">
			{#if preview.commands.length > 0}
				<section data-testid="import-commands">
					<h3 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
						Commands ({preview.commands.length})
					</h3>
					<div class="space-y-2">
						{#each preview.commands as c (c.id)}
							<label
								class="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 text-sm"
							>
								<input
									type="checkbox"
									bind:checked={selectedCommands[c.id]}
									data-testid={`imp-cmd-${c.name}`}
								/>
								<span>
									<span class="font-medium text-[var(--color-text-primary)]"
										>/{c.name}</span
									>
									<span class="text-[var(--color-text-muted)]"> · {c.source}</span>
									{#if c.description}
										<span class="block text-xs text-[var(--color-text-muted)]"
											>{c.description}</span
										>
									{/if}
								</span>
							</label>
						{/each}
					</div>
				</section>
			{/if}

			{#if preview.skills.length > 0}
				<section data-testid="import-skills">
					<h3 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
						Skills ({preview.skills.length})
					</h3>
					<p class="mb-2 text-xs text-[var(--color-text-muted)]">
						Imported skills run their bundled scripts via the
						<code>skill_info</code> / <code>list_scripts</code> /
						<code>run_script</code> tools, sandboxed like any extension. They
						install <strong>disabled</strong> — review permissions and enable
						from the Extensions page.
					</p>
					<div class="space-y-2">
						{#each preview.skills as s (s.id)}
							<label
								class="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 text-sm"
							>
								<input
									type="checkbox"
									bind:checked={selectedSkills[s.id]}
									data-testid={`imp-skill-${s.name}`}
								/>
								<span>
									<span class="font-medium text-[var(--color-text-primary)]"
										>{s.rawName}</span
									>
									<span class="text-[var(--color-text-muted)]">
										· {s.scriptCount} script{s.scriptCount === 1 ? "" : "s"}</span
									>
									{#if s.description}
										<span class="block text-xs text-[var(--color-text-muted)]"
											>{s.description}</span
										>
									{/if}
								</span>
							</label>
						{/each}
					</div>
				</section>
			{/if}

			<button
				class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
				onclick={commit}
				disabled={busy}
				data-testid="import-submit"
			>
				{busy ? "Importing…" : "Import selected"}
			</button>
		</div>
	{/if}

	{#if step === 3}
		<div class="space-y-4" data-testid="import-results">
			<div class="space-y-2">
				{#each results as r (r.kind + r.requested + (r.finalName ?? ""))}
					<div
						class="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 text-sm"
						data-testid="import-result-row"
					>
						<span>
							<span
								class={r.status === "ok"
									? "text-green-400"
									: "text-[var(--color-text-muted)]"}
								>{r.status === "ok" ? "✓" : "—"}</span
							>
							<span class="text-[var(--color-text-primary)]">
								{r.kind}: {r.finalName ?? r.requested}</span
							>
							{#if r.message}
								<span class="text-xs text-[var(--color-text-muted)]">
									({r.message})</span
								>
							{/if}
						</span>
						{#if r.status === "ok"}
							<button
								class="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
								onclick={() => removeItem(r)}
								data-testid="import-remove"
							>
								Remove
							</button>
						{/if}
					</div>
				{/each}
			</div>

			{#if okResults.length > 0}
				<button
					class="rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-400 hover:bg-red-900/30"
					onclick={undoAll}
					data-testid="import-undo"
				>
					Undo this import ({okResults.length})
				</button>
			{/if}
		</div>
	{/if}
</div>
