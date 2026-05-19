/**
 * Re-exports the EmptyComponent.svelte default so tests can replace
 * heavy child imports via `vi.mock(..., () => ({ default: ... }))`
 * without leaking Svelte-specific syntax into the test source.
 */
import EmptyComponent from "./EmptyComponent.svelte";
export default EmptyComponent;
