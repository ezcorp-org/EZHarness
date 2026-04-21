<script lang="ts">
	import type { InputField } from "$lib/api.js";

	let { value = $bindable(""), field }: { value: string; field: InputField } = $props();
</script>

<input
	type="text"
	bind:value
	placeholder={field.description ?? ""}
	class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
/>
