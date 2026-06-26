// Shared input styling. Theme-aware (reads the semantic surface/text/border
// tokens, so it renders correctly in both light and dark — the old
// `bg-gray-900 text-white` was always dark), with an accent focus ring for a
// clear, accessible focus state. Consumed by ~19 form surfaces.
export const inputClass =
	"w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
