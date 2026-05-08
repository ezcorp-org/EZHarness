<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { sendToolPermissionResponse } from "$lib/stores.svelte.js";
	import { getSecurityNote, extractInputSummary } from "./utils.js";

	let { toolCall }: { toolCall: ToolCallState } = $props();
	let loading = $state(false);

	let securityNote = $derived(getSecurityNote(toolCall.category));

	let inputSummary = $derived(extractInputSummary(toolCall.input) ?? '');

	// Phase 6: extension-scoped permission request? Routes the modal to
	// the four-scope chooser when extensionId is set. Built-in tool
	// gates (no extensionId) keep the legacy two-button Allow/Deny.
	let isExtensionRequest = $derived(toolCall.extensionId !== undefined && toolCall.extensionId.length > 0);

	// Human-readable description of what's being requested.
	let extensionRequestDescription = $derived.by(() => {
		if (!isExtensionRequest) return '';
		if (toolCall.capabilityKind === 'shell') {
			return 'Execute shell commands';
		}
		if (toolCall.capabilityKind === 'fs.write') {
			return toolCall.capabilityValue
				? `Write to filesystem: ${toolCall.capabilityValue}`
				: 'Write to filesystem';
		}
		return `Use capability ${toolCall.capabilityKind ?? '(unknown)'}`;
	});

	type Scope = 'session' | 'conversation' | 'project' | 'forever';

	async function handleAllow(scope?: Scope) {
		if (!toolCall.id) return;
		loading = true;
		try {
			// Built-in tool gates ignore the scope arg server-side; only
			// extension-scoped gates honor it.
			await sendToolPermissionResponse(toolCall.id, true, scope);
		} finally {
			loading = false;
		}
	}

	async function handleDeny() {
		if (!toolCall.id) return;
		await sendToolPermissionResponse(toolCall.id, false);
	}
</script>

<div class="rounded-md border border-amber-500/40 bg-amber-900/10 overflow-hidden" data-testid="permission-gate">
	<div class="px-3 py-2">
		<div class="flex items-center gap-2 mb-2">
			<svg class="h-4 w-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
			</svg>
			<span class="text-sm font-medium text-[var(--color-text-primary)]">{toolCall.toolName}</span>
			{#if isExtensionRequest && toolCall.extensionId}
				<span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-300" data-testid="permission-extension-badge">{toolCall.extensionId}</span>
			{/if}
			{#if toolCall.category}
				<span class="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">{toolCall.category}</span>
			{/if}
		</div>

		{#if isExtensionRequest}
			<p class="mb-2 text-sm text-[var(--color-text-primary)]" data-testid="permission-extension-description">
				This extension wants to: <span class="font-medium">{extensionRequestDescription}</span>
			</p>
		{/if}

		{#if inputSummary}
			<pre class="mb-2 rounded bg-[var(--color-surface-secondary)] p-2 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{inputSummary}</pre>
		{/if}

		{#if securityNote}
			<p class="mb-3 text-xs text-amber-300/80">{securityNote}</p>
		{/if}

		{#if isExtensionRequest}
			<!--
				Phase 6: extension-scoped four-scope chooser. The default
				is "session" (least surprise — expires on conversation
				end / restart) per the spec lock-in. The UI must NOT
				default to "forever".
			-->
			<div class="flex flex-wrap gap-2" data-testid="permission-scope-chooser">
				<button
					onclick={() => handleAllow('session')}
					disabled={loading}
					data-testid="permission-allow-session"
					class="rounded px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50"
				>
					{loading ? 'Working...' : 'Allow this time'}
				</button>
				<button
					onclick={() => handleAllow('conversation')}
					disabled={loading}
					data-testid="permission-allow-conversation"
					class="rounded px-3 py-1.5 text-xs font-medium bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
				>
					Allow for this conversation
				</button>
				<button
					onclick={() => handleAllow('project')}
					disabled={loading}
					data-testid="permission-allow-project"
					class="rounded px-3 py-1.5 text-xs font-medium bg-green-800 hover:bg-green-700 text-white transition-colors disabled:opacity-50"
				>
					Allow for this project
				</button>
				<button
					onclick={() => handleAllow('forever')}
					disabled={loading}
					data-testid="permission-allow-forever"
					class="rounded px-3 py-1.5 text-xs font-medium bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
				>
					Always allow
				</button>
				<button
					onclick={handleDeny}
					disabled={loading}
					data-testid="permission-deny"
					class="rounded px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
				>
					Deny
				</button>
			</div>
		{:else}
			<!-- Built-in tool gate: legacy two-button modal. -->
			<div class="flex gap-2">
				<button
					onclick={() => handleAllow()}
					disabled={loading}
					data-testid="permission-allow"
					class="rounded px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50"
				>
					{loading ? 'Allowing...' : 'Allow'}
				</button>
				<button
					onclick={handleDeny}
					disabled={loading}
					data-testid="permission-deny"
					class="rounded px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
				>
					Deny
				</button>
			</div>
		{/if}
	</div>
</div>
