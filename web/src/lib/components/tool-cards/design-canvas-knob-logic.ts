// Pure helpers for DesignCanvasCard's knob-body build path.
//
// Extracted from the Svelte component so the logic — especially the
// scale-spacing signed-delta encoding — can be unit-tested without
// rendering and shared with anything that needs to translate raw form
// state into the wire shape the `claude-design:knob-change` route
// expects.
//
// The scale-spacing rule is the load-bearing invariant: a percent
// slider's value is a DELTA (e.g. "+30%" means 30% bigger than baseline,
// not "30% of baseline"). Backend's `parseScaleFactor` accepts both
// `+N%` (delta) and `N%` (absolute pct), so encoding the sign here is
// what disambiguates them. Without the sign, "30%" parses as 0.30 —
// every spacing token shrinks to a third of its base value and the
// design looks "very zoomed in" because text crowds against itself.

/** Subset of the canvas card's `KnobDescriptor` shape that affects how
 *  values are encoded for the wire. The full descriptor type lives in
 *  the Svelte component's $props block; this module only consumes the
 *  fields that drive `buildKnobBody` so the type-coupling stays narrow. */
export interface KnobBodyDescriptor {
  key: string;
  kind: "color" | "range" | "select" | "text";
  behavior?: "scale-spacing";
  unit?: "px" | "rem" | "em" | "%" | "";
}

/**
 * Encode a single knob value for the POST body.
 *
 * Returns `null` when the value should be omitted (empty / whitespace),
 * with the one exception that `kind: "range"` treats a numeric `0` as
 * meaningful (e.g. `borderRadius: "0"` → `"0px"` is a real override).
 *
 * The wire format per descriptor.kind:
 *   - range + behavior:"scale-spacing" + unit:"%": signed delta string
 *     ("+30%", "-15%", "+0%") — backend's `parseScaleFactor` reads this
 *     as `1 + N/100`. The sign is what avoids the absolute-pct branch.
 *   - range (any other shape): `${value}${unit ?? ""}` — bare numeric
 *     plus the descriptor's unit ("12px", "1rem", "0px").
 *   - color / select / text: raw value, no formatting.
 */
export function encodeKnobValue(
  descriptor: KnobBodyDescriptor,
  rawValue: string | number | null | undefined,
): string | null {
  if (rawValue == null) return null;
  const s = String(rawValue);
  const trimmed = s.trim();
  // Range "0" is meaningful (borderRadius=0px, spacingScale=0%). Every
  // other knob with an empty value means "no override" — drop it so
  // existing draft defaults aren't overwritten.
  const isMeaningfulZero =
    descriptor.kind === "range" && trimmed !== "" && Number(trimmed) === 0;
  if (!isMeaningfulZero && trimmed === "") return null;

  if (descriptor.kind !== "range") return s;

  // Range: format the numeric value. Scale-spacing percent sliders need
  // signed-delta encoding so the backend's parseScaleFactor reads them
  // as relative (1+N/100) rather than absolute (N/100).
  if (descriptor.behavior === "scale-spacing" && descriptor.unit === "%") {
    return formatSignedPercent(trimmed);
  }
  return s + (descriptor.unit ?? "");
}

/** Build the full knob-change POST body from a descriptor list and the
 *  current form values map. Skips knobs whose value `encodeKnobValue`
 *  returns `null` for. Pure — exports the exact algorithm
 *  `DesignCanvasCard.svelte`'s "Apply knobs" button uses. */
export function buildKnobBody(
  descriptors: KnobBodyDescriptor[],
  values: Record<string, string | number | null | undefined>,
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const d of descriptors) {
    const encoded = encodeKnobValue(d, values[d.key]);
    if (encoded !== null) body[d.key] = encoded;
  }
  return body;
}

/** Format a numeric string as a signed percentage suitable for the
 *  backend's `parseScaleFactor` "+N%" / "-N%" branch. `0` becomes
 *  `"+0%"` (kept signed for symmetry — backend treats it as no-op). */
function formatSignedPercent(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}%`;
  if (n < 0) return `${n}%`; // negative number stringifies with leading "-"
  return `+${n}%`;
}
