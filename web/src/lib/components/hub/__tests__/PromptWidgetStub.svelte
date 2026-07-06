<script lang="ts">
	// Test-only stand-in for a shared format widget (SharedFilePicker / DatePicker
	// / …). HubPageView's format branch renders the format component with a
	// `bind:value` plus `size` / `absolute` / `placeholder` props; the real
	// widgets don't cleanly mount under jsdom (so v8 never attributes the
	// `<PromptWidget …>` prop lines as covered). This stub accepts exactly those
	// props — `value` is `$bindable` so the host's two-way binding wires up — and
	// reflects them into the DOM so the test can assert they were passed through.
	let {
		value = $bindable(""),
		size = undefined,
		absolute = undefined,
		placeholder = undefined,
	}: {
		value?: string;
		size?: string;
		absolute?: boolean;
		placeholder?: string;
	} = $props();
</script>

<input
	data-testid="prompt-widget-stub"
	data-size={size}
	data-absolute={String(absolute)}
	{placeholder}
	bind:value
/>
