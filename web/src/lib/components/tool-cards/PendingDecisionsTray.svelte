<script lang="ts">
	import { store, dismissPendingApproval } from "$lib/stores.svelte.js";
	import PendingApprovalCard from "./PendingApprovalCard.svelte";
	import PendingPermissionTray from "./PendingPermissionTray.svelte";

	/**
	 * The one bottom-right stack for decisions the user has to make that
	 * have nowhere inline to live.
	 *
	 * It exists because there are now TWO such kinds — a permission prompt
	 * with no active run, and a workflow run parked on an approval — and
	 * each owning its own `fixed bottom-4 right-4` container would put them
	 * exactly on top of each other. One container, both stacks; the
	 * permission tray keeps its own region (and its testid) inside it.
	 *
	 * Approvals render ABOVE permissions deliberately: a permission prompt
	 * blocks a tool call that is waiting right now, so it sits closest to
	 * the corner where the eye lands and where a click is cheapest.
	 */
	let approvals = $derived(store.pendingApprovals);
	let permissions = $derived(store.pendingPermissions);
</script>

{#if approvals.length > 0 || permissions.length > 0}
	<div
		class="fixed bottom-4 right-4 z-[60] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-3"
		data-testid="pending-decisions-tray"
	>
		{#if approvals.length > 0}
			<div
				class="flex flex-col gap-3"
				data-testid="pending-approval-tray"
				role="region"
				aria-label="Workflow approvals awaiting your decision"
			>
				{#each approvals as approval (approval.approvalId)}
					<PendingApprovalCard
						{approval}
						onResolved={() => dismissPendingApproval(approval.approvalId)}
					/>
				{/each}
			</div>
		{/if}
		<PendingPermissionTray />
	</div>
{/if}
