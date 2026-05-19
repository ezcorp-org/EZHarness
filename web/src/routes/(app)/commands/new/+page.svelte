<script lang="ts">
	import { goto } from "$app/navigation";
	import {
		createUserCommand,
		type UserCommand,
	} from "$lib/api.js";
	import { addToast } from "$lib/toast.svelte.js";
	import CommandForm, { type CommandFormPayload } from "$lib/components/CommandForm.svelte";

	let submitting = $state(false);
	let errorMsg = $state("");

	async function handleSubmit(payload: CommandFormPayload) {
		submitting = true;
		errorMsg = "";
		try {
			// Save server-side. The DB layer's auto-suffix means the
			// returned `name` may differ from what the user typed — we
			// detect that and surface a toast (`Saved as "review-2" —
			// "review" already exists`).
			const requested = payload.name ?? "";
			const saved: UserCommand = await createUserCommand({
				name: requested,
				description: payload.description,
				body: payload.body,
				frontmatter: payload.frontmatter,
			});
			if (saved.name !== requested && requested) {
				addToast({
					type: "info",
					message: `Saved as "${saved.name}" — "${requested}" already exists`,
				}, 8000);
			} else {
				addToast({ type: "success", message: `Created /${saved.name}` });
			}
			goto(`/commands/${encodeURIComponent(saved.name)}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to create command";
			addToast({ type: "error", message: errorMsg });
		} finally {
			submitting = false;
		}
	}

	function handleCancel() {
		goto("/commands");
	}
</script>

<div class="space-y-6">
	<div>
		<a href="/commands" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">
			&larr; Back to Commands
		</a>
	</div>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<div class="mb-6">
			<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">New Command</h2>
		</div>
		<CommandForm
			mode="create"
			{submitting}
			onsubmit={handleSubmit}
			oncancel={handleCancel}
		/>
		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400" data-testid="commands-new-error">{errorMsg}</p>
		{/if}
	</div>
</div>
