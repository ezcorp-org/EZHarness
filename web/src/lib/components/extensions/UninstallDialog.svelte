<!--
  UninstallDialog — confirm a full extension delete, and settle what happens
  to the extension's FILES.

  The scope of the choice is deliberately narrow, and the copy says so.
  An extension keeps state in two places, and only one of them is
  negotiable:

    - DATABASE (`extension_storage`, `extension_settings_user`,
      `extension_secrets`): every one of those tables cascades off the
      `extensions` row, so uninstalling destroys them whatever the user
      picks. An earlier draft of this dialog offered to "keep" that state
      and promised a reinstall would "pick up where you left off" — a
      promise the schema cannot honour. Saying so plainly is the point:
      this is a consent surface, and a consent surface that overstates what
      it preserves is worse than one that offers no choice at all.
    - FILES under `.ezcorp/extension-data/<name>/`: genuinely optional, and
      the only thing the radios govern.

  No safe default exists even for the narrowed question, so neither radio is
  preselected and "Uninstall" stays disabled until one is chosen. A
  preselected destructive option is how people delete things they meant to
  keep; a preselected safe one leaves directories nobody remembers to clean
  up.

  Shared by the Extensions library grid and the extension detail page, which
  is why the fetch lives in the caller: this component owns the decision, not
  the request.
-->
<script lang="ts">
	type DataChoice = "delete" | "keep";

	let {
		open = false,
		extensionName,
		busy = false,
		onconfirm,
		oncancel,
	}: {
		open: boolean;
		/** Manifest name — also names the data directory shown to the user. */
		extensionName: string;
		/** Caller's request is in flight; both buttons lock. */
		busy?: boolean;
		onconfirm: (opts: { purgeData: boolean }) => void;
		oncancel: () => void;
	} = $props();

	let dataChoice = $state<DataChoice | null>(null);

	// Reset on every open so a previous "delete" can never carry into the
	// next extension's dialog.
	$effect(() => {
		if (open) dataChoice = null;
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && !busy) oncancel();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget && !busy) oncancel();
	}

	function confirm() {
		if (dataChoice === null) return;
		onconfirm({ purgeData: dataChoice === "delete" });
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onkeydown={handleKeydown}
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
		aria-labelledby="uninstall-dialog-title"
		data-testid="uninstall-dialog"
		tabindex={-1}
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<h3 id="uninstall-dialog-title" class="text-base font-semibold text-[var(--color-text-primary)]">
				Uninstall {extensionName}
			</h3>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
				This removes the extension, its tools and its permissions. Its saved
				settings, secrets and stored keys go with it &mdash; those live in the
				database and cannot be kept.
			</p>

			<fieldset class="mt-4">
				<legend class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
					Its files
				</legend>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">
					Files this extension wrote &mdash; documents, exports, caches &mdash; live in
					<code class="rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5">.ezcorp/extension-data/{extensionName}/</code>
				</p>

				<div class="mt-3 space-y-2">
					<label
						class="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm transition-colors hover:border-[var(--color-accent)]"
					>
						<input
							type="radio"
							name="uninstall-data-choice"
							value="keep"
							checked={dataChoice === "keep"}
							onchange={() => (dataChoice = "keep")}
							disabled={busy}
							class="mt-0.5"
							data-testid="uninstall-keep-data"
						/>
						<span>
							<span class="font-medium text-[var(--color-text-primary)]">Keep its files</span>
							<span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">
								The directory stays on disk. Reinstalling reuses whatever is in it.
							</span>
						</span>
					</label>

					<label
						class="flex cursor-pointer items-start gap-2 rounded-md border border-red-900/60 bg-red-900/20 p-3 text-sm transition-colors hover:border-red-700"
					>
						<input
							type="radio"
							name="uninstall-data-choice"
							value="delete"
							checked={dataChoice === "delete"}
							onchange={() => (dataChoice = "delete")}
							disabled={busy}
							class="mt-0.5"
							data-testid="uninstall-delete-data"
						/>
						<span>
							<span class="font-medium text-red-200">Delete its files</span>
							<span class="mt-0.5 block text-xs text-red-300/80">
								Removes the directory above too. This cannot be undone.
							</span>
						</span>
					</label>
				</div>
			</fieldset>

			<div class="mt-6 flex justify-end gap-2">
				<button
					onclick={oncancel}
					disabled={busy}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={confirm}
					disabled={busy || dataChoice === null}
					title={dataChoice === null ? "Choose what happens to the stored data first" : undefined}
					class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
					data-testid="uninstall-confirm"
				>
					{busy ? "Uninstalling…" : "Uninstall"}
				</button>
			</div>
		</div>
	</div>
{/if}
