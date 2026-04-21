<script lang="ts">
	import SharedFilePicker from "./ui/SharedFilePicker.svelte";

	let {
		value = $bindable(""),
		placeholder = "Enter file path...",
	}: { value: string; placeholder?: string } = $props();
</script>

<SharedFilePicker bind:value {placeholder} size="sm" />
