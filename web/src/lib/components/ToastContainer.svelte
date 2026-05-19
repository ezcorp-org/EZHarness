<script lang="ts">
	import { toastStore } from "$lib/toast.svelte.js";
	import Toast from "./Toast.svelte";
</script>

<div
	class="fixed top-4 right-4 z-[60] flex flex-col gap-2"
	role="log"
	aria-live="polite"
>
	{#each toastStore.toasts as toast (toast.id)}
		<Toast {toast} onclose={(id) => toastStore.remove(id)} />
	{/each}
</div>
