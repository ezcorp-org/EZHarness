<script lang="ts">
	import MentionChip from "./MentionChip.svelte";
	import { getSegments } from "$lib/mention-logic.js";

	let {
		text,
	}: {
		text: string;
	} = $props();

	let segments = $derived(getSegments(text));
	let hasMentions = $derived(segments.some(s => s.type === "mention"));
</script>

{#if hasMentions}{#each segments as seg}{#if seg.type === "text"}{seg.text}{:else if seg.type === "mention"}<MentionChip name={seg.name} kind={seg.kind === 'ext' ? 'extension' : seg.kind === 'cmd' ? 'command' : seg.kind as 'agent' | 'team' | 'file' | 'dir'} />{/if}{/each}{:else}{text}{/if}
