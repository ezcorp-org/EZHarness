// ── PanelBuilder — chainable panel-state assembly ───────────────
//
// Collapses the 40–80-line panel payload construction copied across
// example extensions (see docs/extensions/examples/auto-note/index.ts
// emitPanelState for the canonical shape) into a fluent builder.
// Terminal `.send()` fires the `ezcorp/state` notification on the host
// channel.
//
// Extension Pages Hub Phase 2 hoisted the chainable component methods
// into the shared `ComponentListBuilder` base (./component-builder.ts)
// so `PageBuilder` (./page.ts) reuses them verbatim — this module now
// only owns the panel-specific terminal `.send()`. Public surface
// (class name, method names, types re-exported below) is unchanged.

import { getChannel } from "./channel";
import { ComponentListBuilder } from "./component-builder";

export type {
  PanelColor,
  PanelTextVariant,
  PanelStatusState,
  PanelListItemStatus,
  PanelBuilderListItem,
  PanelBuilderAction,
} from "./component-builder";

export class PanelBuilder extends ComponentListBuilder {
  /**
   * Dispatch the accumulated components as an `ezcorp/state`
   * notification. Throws synchronously if no title was set via either
   * the constructor or a prior `.title(...)` call — an untitled panel
   * is always a caller bug.
   */
  async send(): Promise<void> {
    const title = this.resolveTitle();
    if (title === undefined) {
      throw new Error(
        "[@ezcorp/sdk] PanelBuilder.send(): missing title — call .title(...) first or pass a title to the constructor",
      );
    }
    getChannel().notify("ezcorp/state", {
      title,
      components: this.components,
    });
  }
}
