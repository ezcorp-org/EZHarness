// ── ComponentListBuilder — shared chainable component accumulator ──
//
// Base class for the two declarative UI builders:
//   - PanelBuilder (runtime/panel.ts)  → bottom panel, terminal .send()
//   - PageBuilder  (runtime/page.ts)   → Hub pages, terminal .build()
//
// Extracted from PanelBuilder (Extension Pages Hub Phase 2) so the
// nine panel-vocabulary component methods exist exactly once. Methods
// return `this`, so subclass chains keep their subclass type without
// generics (TS polymorphic `this`).
//
// Components are pushed as structural objects rather than typed unions
// — the wire protocol accepts forward-compat additions that aren't yet
// in the host's typed vocabulary; the host validator is the authority.

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

export class ComponentListBuilder {
  protected readonly components: unknown[] = [];
  protected firstTitle: string | undefined;
  protected readonly fallbackTitle: string | undefined;

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

  /** Title resolution shared by `.send()` (panel) and `.build()` (page). */
  protected resolveTitle(): string | undefined {
    return this.firstTitle ?? this.fallbackTitle;
  }
}
