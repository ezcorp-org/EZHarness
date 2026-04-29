/**
 * Phase 48 Wave 3 — global state for the Ez panel.
 *
 * Single source of truth for whether the EzPanel is open, plus a
 * scratch `pendingPrompt` slot used by the CommandPalette "Ask Ez"
 * command to pre-fill the composer when the panel opens. Kept
 * intentionally tiny — anything else lives inside the panel itself.
 */

interface EzPanelState {
  open: boolean;
  pendingPrompt: string;
}

export const ezPanelState: EzPanelState = $state({
  open: false,
  pendingPrompt: "",
});

export function openEzPanel(prefill = ""): void {
  ezPanelState.pendingPrompt = prefill;
  ezPanelState.open = true;
}

export function closeEzPanel(): void {
  ezPanelState.open = false;
  ezPanelState.pendingPrompt = "";
}

export function consumePendingPrompt(): string {
  const p = ezPanelState.pendingPrompt;
  ezPanelState.pendingPrompt = "";
  return p;
}
