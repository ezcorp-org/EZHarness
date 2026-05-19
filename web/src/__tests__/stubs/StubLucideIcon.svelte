<script lang="ts">
	/**
	 * Test stub injected via `__setIconLoader(...)` so DOM tests can
	 * inspect the props that LucideIcon forwards into its dynamically-
	 * resolved child. Mirrors lucide-svelte's legacy-mode contract:
	 * `width={size}` / `height={size}` land as SVG attributes (default
	 * 24 if `size` is undefined). The real component also propagates
	 * the `class` prop, so we mirror that too — the test then queries
	 * the rendered SVG by class.
	 *
	 * The synthetic `data-stub-name` attribute is a stable hook for
	 * "did the resolver pick the fallback?" assertions.
	 */
	let {
		size,
		class: className = "",
		strokeWidth = 2,
		stubName = "",
	}: {
		size?: number;
		class?: string;
		strokeWidth?: number;
		stubName?: string;
	} = $props();
</script>

<svg
	class={className}
	width={size === undefined ? 24 : size}
	height={size === undefined ? 24 : size}
	stroke-width={strokeWidth}
	data-size-prop={size === undefined ? "undefined" : String(size)}
	data-stub-name={stubName}
	data-testid="stub-lucide-icon"
></svg>
