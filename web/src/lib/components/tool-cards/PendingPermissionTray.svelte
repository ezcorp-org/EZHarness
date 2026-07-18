<script lang="ts">
	import { store, dismissPendingPermission } from "$lib/stores.svelte.js";
	import PermissionGate from "./PermissionGate.svelte";

	/**
	 * Global fallback tray for permission prompts that have no active run to
	 * host an inline card — the classic case being an EXTENSION-initiated
	 * privileged tool call (ez-code-factory's `init_gate` hitting fs.write /
	 * shell). The backend permission gate works; without this surface the
	 * approval card simply never renders and the gate hangs forever.
	 *
	 * Mounted once at (app)-layout scope alongside DockHost. Renders as a
	 * fixed bottom-right stack so it overlays every route. Each card resolves
	 * through the same PermissionGate + POST /api/tool-calls/:id/permission
	 * path as the inline gate — we only add a render surface, we do NOT change
	 * any permission-decision logic (fail-closed: no auto-approve, ever).
	 */
	let prompts = $derived(store.pendingPermissions);
</script>

{#if prompts.length > 0}
	<div
		class="fixed bottom-4 right-4 z-[60] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-3"
		data-testid="pending-permission-tray"
		role="region"
		aria-label="Pending permission requests"
	>
		{#each prompts as prompt (prompt.id)}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 shadow-xl">
				<div class="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)]">
					<span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400"></span>
					<span>Permission needed{prompt.extensionId ? ` — ${prompt.extensionId}` : ''}</span>
				</div>
				<PermissionGate
					toolCall={prompt}
					onResolved={() => prompt.id && dismissPendingPermission(prompt.id)}
				/>
			</div>
		{/each}
	</div>
{/if}
