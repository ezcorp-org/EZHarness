<script lang="ts">
	let { sandbox }: { projectId: string; sandbox: boolean } = $props();
</script>
<div data-testid="sandbox-panel-stub" data-sandbox={String(sandbox)}></div>
