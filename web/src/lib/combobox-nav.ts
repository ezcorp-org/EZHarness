/**
 * Shared keyboard navigation logic for combobox-style dropdowns.
 * Returns the new highlight index after processing a keyboard event.
 * Returns null if the event was not handled (caller should not preventDefault).
 */
export function handleComboboxKeydown(
  e: KeyboardEvent,
  opts: {
    itemCount: number;
    highlightIndex: number;
    onSelect: (index: number) => void;
    onClose: () => void;
  },
): number | null {
  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      if (opts.itemCount === 0) return opts.highlightIndex;
      return (opts.highlightIndex + 1) % opts.itemCount;
    }
    case "ArrowUp": {
      e.preventDefault();
      if (opts.itemCount === 0) return opts.highlightIndex;
      return (opts.highlightIndex - 1 + opts.itemCount) % opts.itemCount;
    }
    case "Enter": {
      e.preventDefault();
      if (opts.highlightIndex >= 0 && opts.highlightIndex < opts.itemCount) {
        opts.onSelect(opts.highlightIndex);
      }
      return opts.highlightIndex;
    }
    case "Escape": {
      e.preventDefault();
      opts.onClose();
      return -1;
    }
    default:
      return null;
  }
}
