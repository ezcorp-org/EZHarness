// ── PanelBuilder — chainable panel-state assembly ───────────────
//
// Collapses the 40–80-line panel payload construction copied across
// example extensions (see docs/extensions/examples/auto-note/index.ts
// emitPanelState for the canonical shape) into a fluent builder.
// Terminal `.send()` fires the `ezcorp/state` notification on the host
// channel.
//
// Components are pushed as structural objects rather than typed via
// PanelComponent — auto-note emits `components: unknown[]` for the
// same reason: the wire protocol accepts forward-compat additions
// (e.g. `type:"action"`) that aren't yet in the host's typed union.

import { getChannel } from "./channel";

export type PanelColor =
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "purple"
  | "gray";

export type PanelTextVariant = "muted" | "default" | "emphasis";

export type PanelStatusState =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "warning";

export type PanelListItemStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed";

export interface PanelBuilderListItem {
  label: string;
  status?: PanelListItemStatus;
  detail?: string;
  badge?: string;
  badgeColor?: PanelColor;
}

export interface PanelBuilderAction {
  label: string;
  command?: string;
}

export class PanelBuilder {
  private readonly components: unknown[] = [];
  private firstTitle: string | undefined;
  private readonly fallbackTitle: string | undefined;

  constructor(title?: string) {
    this.fallbackTitle = title;
  }

  /** First call wins as the panel's header title if no constructor arg was given. */
  title(title: string, subtitle?: string): this {
    if (this.firstTitle === undefined) this.firstTitle = title;
    this.components.push(
      subtitle !== undefined
        ? { type: "header", title, subtitle }
        : { type: "header", title },
    );
    return this;
  }

  markdown(content: string, variant?: PanelTextVariant): this {
    this.components.push(
      variant !== undefined
        ? { type: "text", content, variant }
        : { type: "text", content },
    );
    return this;
  }

  list(items: PanelBuilderListItem[]): this {
    this.components.push({ type: "list", items });
    return this;
  }

  action(action: PanelBuilderAction): this {
    this.components.push(
      action.command !== undefined
        ? { type: "action", label: action.label, command: action.command }
        : { type: "action", label: action.label },
    );
    return this;
  }

  divider(): this {
    this.components.push({ type: "divider" });
    return this;
  }

  badge(label: string, color?: PanelColor): this {
    this.components.push(
      color !== undefined
        ? { type: "badge", label, color }
        : { type: "badge", label },
    );
    return this;
  }

  counter(label: string, value: number, total?: number): this {
    this.components.push(
      total !== undefined
        ? { type: "counter", label, value, total }
        : { type: "counter", label, value },
    );
    return this;
  }

  kv(pairs: { key: string; value: string }[]): this {
    this.components.push({ type: "kv", pairs });
    return this;
  }

  progress(value: number, label?: string): this {
    this.components.push(
      label !== undefined
        ? { type: "progress", value, label }
        : { type: "progress", value },
    );
    return this;
  }

  status(label: string, state: PanelStatusState): this {
    this.components.push({ type: "status", label, state });
    return this;
  }

  /**
   * Dispatch the accumulated components as an `ezcorp/state`
   * notification. Throws synchronously if no title was set via either
   * the constructor or a prior `.title(...)` call — an untitled panel
   * is always a caller bug.
   */
  async send(): Promise<void> {
    const title = this.firstTitle ?? this.fallbackTitle;
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
