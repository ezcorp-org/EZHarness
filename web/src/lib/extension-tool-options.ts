/**
 * Shared normalization of `GET /api/extensions` into pickable tools.
 *
 * Two surfaces need the same thing out of that response — the per-extension
 * tool checklist in `ExtensionToolSelector.svelte` and the tool picker on a
 * workflow `kind: "tool"` step — so the shape-tolerance lives here once
 * rather than being re-derived in each component.
 *
 * Framework-free and pure so it is unit-testable at 100%; the `.svelte`
 * files stay thin bindings over it (they are excluded from the coverage
 * gate, so logic in them is logic nothing checks).
 */

/** One extension and the tools its manifest declares. */
export interface ExtensionToolSource {
  id: string;
  name: string;
  tools: { name: string; description?: string | null }[];
}

/** One selectable tool, pre-rendered for a `<select>`/checklist. */
export interface ToolOption {
  /** Owning extension id — the `<optgroup>` key. */
  extension: string;
  /** Human label for the owning extension. */
  extensionLabel: string;
  /** Bare tool name, as declared in the manifest. */
  tool: string;
  /** The value a workflow `tool` step stores. */
  value: string;
  description?: string | null;
}

/**
 * The runtime's extension-tool namespace separator.
 *
 * A DOUBLE UNDERSCORE, not a dot: Anthropic's tool-name pattern
 * `^[a-zA-Z0-9_-]+$` rejects dots, so `src/extensions/registry.ts`
 * namespaces as `<ext>__<tool>`. Getting this wrong produces a workflow
 * step that validates fine and then fails at dispatch with an unknown tool.
 */
export const TOOL_NAMESPACE_SEPARATOR = "__";

/** Compose the runtime-namespaced name a `kind: "tool"` step stores. */
export function namespacedToolName(extension: string, tool: string): string {
  return `${extension}${TOOL_NAMESPACE_SEPARATOR}${tool}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize whatever `GET /api/extensions` returned into a stable list.
 *
 * Tolerant by design — the endpoint has served both a bare array and a
 * `{ extensions: [...] }` envelope, and an extension may legitimately
 * declare no tools. Anything unparseable degrades to an empty list rather
 * than throwing: a malformed entry must not blank out the whole picker.
 */
export function parseExtensionList(payload: unknown): ExtensionToolSource[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.extensions)
      ? payload.extensions
      : [];

  const out: ExtensionToolSource[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const manifest = isRecord(entry.manifest) ? entry.manifest : undefined;
    const rawTools = Array.isArray(manifest?.tools) ? manifest.tools : [];
    const tools: ExtensionToolSource["tools"] = [];
    for (const tool of rawTools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : null,
      });
    }
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      tools,
    });
  }
  return out;
}

/**
 * Flatten normalized extensions into one option per tool.
 *
 * Extensions exposing no tools drop out — an empty `<optgroup>` is a dead
 * row in the picker.
 */
export function toToolOptions(sources: ExtensionToolSource[]): ToolOption[] {
  return sources.flatMap((source) =>
    source.tools.map((tool) => ({
      extension: source.id,
      extensionLabel: source.name,
      tool: tool.name,
      value: namespacedToolName(source.id, tool.name),
      description: tool.description ?? null,
    })),
  );
}

/** Group options by owning extension, preserving encounter order, so a
 *  picker can render one `<optgroup>` per extension. */
export function groupToolOptions(
  options: ToolOption[],
): { extension: string; label: string; options: ToolOption[] }[] {
  const groups = new Map<string, { extension: string; label: string; options: ToolOption[] }>();
  for (const option of options) {
    let group = groups.get(option.extension);
    if (!group) {
      group = { extension: option.extension, label: option.extensionLabel, options: [] };
      groups.set(option.extension, group);
    }
    group.options.push(option);
  }
  return [...groups.values()];
}
