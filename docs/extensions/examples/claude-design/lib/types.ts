// Shared types for the claude-design extension.
//
// Kept narrow — extension-internal types should not leak into the
// extension-data files. The `DesignSystem` shape IS persisted to
// design-system.json, so changing its structure is a migration; bump
// `schemaVersion` and add a reader for the old shape.

/** Source of truth for the extracted tokens. */
export type DesignSystemSource =
  | "tokens.json"
  | "tailwind"
  | "css-vars"
  | "theme.ts"
  | "greenfield";

export interface ColorRamp {
  primary: string;
  secondary?: string;
  /** Neutral ramp from darkest to lightest. Length is fixture-dependent. */
  neutral: string[];
  /** Optional named accents the project declares. */
  accents?: Record<string, string>;
}

export interface TypographyScale {
  display: string;
  body: string;
  mono?: string;
  /** Pixel sizes in ascending order. */
  scale: number[];
}

export interface SpacingScale {
  /** Base unit in pixels (8px is the most common default). */
  unit: number;
  /** Pixel sizes in ascending order — multiples of `unit`. */
  scale: number[];
}

export interface ComponentEntry {
  name: string;
  path: string;
}

export interface DesignSystem {
  schemaVersion: 1;
  colors: ColorRamp;
  typography: TypographyScale;
  spacing: SpacingScale;
  components: ComponentEntry[];
  source: DesignSystemSource;
}

export interface DraftMeta {
  schemaVersion: 1;
  draftId: string;
  parentDraftId?: string;
  prompt: string;
  kind: "page" | "slide" | "one-pager" | "component";
  /** Knob hops from parent to this draft. Single-step (not full lineage). */
  knobs?: Record<string, string>;
  createdAt: string;
}

export interface Knobs {
  primaryColor?: string;
  secondaryColor?: string;
  /** "+10%" / "-5%" / "150%" / "1.2" — parsed by tweak. */
  spacingScale?: string;
  /** px value (e.g. "0", "4", "8"). */
  borderRadius?: string;
  density?: "compact" | "cozy" | "spacious";
}
