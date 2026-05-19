<script lang="ts">
	// Minimal stub for $lib/components/ProviderSettings used by the
	// onboarding wizard component test. Accepts the same bindable
	// `statuses` prop so the wizard's binding wiring is preserved, but
	// does no network calls of its own. Tests can drive `statuses` from
	// the outer harness if they need to flip provider-connected state.
	let { statuses = $bindable([]) }: { statuses?: unknown[] } = $props();
	statuses; // keep TypeScript happy without rendering anything
</script>

<div data-testid="provider-settings-stub"></div>
