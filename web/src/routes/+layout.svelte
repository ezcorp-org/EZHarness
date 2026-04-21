<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";

	let { children } = $props();

	onMount(() => {
		const splash = document.getElementById('splash');
		if (splash) {
			splash.style.opacity = '0';
			setTimeout(() => splash.remove(), 300);
		}
	});
</script>

{@render children()}
