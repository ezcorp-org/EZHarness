/**
 * Mode → effective-tool-scope computation, shared between the executor
 * (which filters the live `ctx.agentTools` before every run) and the
 * `/api/tools` listing endpoint (which powers the chat header's
 * tool-count badge + popover). Single implementation so the badge can
 * never show a different tool surface than the runtime actually grants.
 *
 * Contract (extracted from executor.ts, then generalized so the
 * composer's per-conversation Tools dropdown works without a mode):
 *   - `mode.extensionIds` non-empty → the mode declares its tool surface
 *     via attached extensions. The scope is an allowlist of the union of
 *     those extensions' (namespaced) tool names, optionally narrowed
 *     per-extension by `mode.extensionTools[extId]`, then narrowed again
 *     by the conversation's `extensionTools` map (narrow-only — a tool
 *     outside the mode allowlist can never be re-added). Supersedes any
 *     legacy `toolRestriction` value on the mode.
 *   - otherwise the conversation's `extensionTools` map still narrows:
 *     each extension key denies the registered tools its subset excludes
 *     (EMPTY subset = master toggle OFF, denies all; absent key = all
 *     tools, unchanged). This is what makes the composer's tool toggles
 *     real without a mode — combined with a legacy `mode.toolRestriction`
 *     when one is set (restriction → allow → deny layering in
 *     applyToolFilters).
 *   - nothing to restrict → `null`: no filtering.
 *
 * The returned options feed `applyToolFilters`, which preserves
 * ORCHESTRATION_TOOLS through every layer EXCEPT `forceDeniedTools` —
 * the conv map's exclusions ride that layer precisely so an explicit
 * per-conversation toggle can switch off even ask-user/scratchpad.
 */

import type { ToolFilterOptions } from "./filter";

/** The mode fields the scope decision reads (subset of DbMode). */
export interface ModeToolScopeSource {
  extensionIds?: string[] | null;
  /** Per-extension tool subset: absent key = ALL of that extension's
   *  tools; EMPTY array = extension OFF (no tools); non-empty = subset.
   *  Mirrors web/src/lib/tool-scope-logic.ts. */
  extensionTools?: Record<string, string[]> | null;
  toolRestriction?: "all" | "read-only" | "none" | "allowlist" | null;
  allowedTools?: string[] | null;
}

/** The one registry lookup the computation needs (ExtensionRegistry satisfies it). */
export interface ModeScopeRegistry {
  getToolsForExtension(
    extensionId: string,
  ): Array<{ name: string; originalName: string }>;
}

export function computeModeToolScope(
  mode: ModeToolScopeSource | null | undefined,
  convExtensionTools: Record<string, string[]> | null | undefined,
  registry: ModeScopeRegistry,
): ToolFilterOptions | null {
  const extensionIds = mode?.extensionIds ?? [];
  if (mode && extensionIds.length > 0) {
    // Per-extension tool subset: an extension absent from this map
    // contributes ALL its tools; an EMPTY array means the extension is
    // toggled OFF (contributes nothing); a non-empty array narrows it to
    // just those tools. Match defensively against both the namespaced
    // name and the original (unnamespaced) name so the UI can persist
    // either form; the allowlist set itself always carries the
    // namespaced name applyToolFilters filters on.
    const perTool = mode.extensionTools ?? {};
    const allowed = new Set<string>();
    // Tool (namespaced) name → { extId, originalName }. Built while
    // iterating mode extensions so the per-conversation narrowing pass
    // below can resolve each allowed tool back to its extension + the
    // unnamespaced name the conv subset may reference.
    const toolOwner = new Map<string, { extId: string; originalName: string }>();
    for (const extId of extensionIds) {
      const subset = perTool[extId];
      if (subset && subset.length === 0) continue; // extension toggled off
      for (const t of registry.getToolsForExtension(extId)) {
        if (
          !subset ||
          subset.includes(t.name) || subset.includes(t.originalName)
        ) {
          allowed.add(t.name);
          toolOwner.set(t.name, { extId, originalName: t.originalName });
        }
      }
    }

    // ── Per-conversation narrowing (Phase 4/D) ──
    // The conversation's extensionTools map can only NARROW the mode's
    // allowlist, never widen it (a tool not already in `allowed` can't
    // be re-added). For each allowed tool whose owning extension is a
    // key in conv.extensionTools: an EMPTY subset removes the whole
    // extension (master toggle OFF); a non-empty subset keeps the tool
    // only if it includes its name or originalName. Extensions absent
    // from the conv map pass through unchanged ("absent = all").
    if (convExtensionTools && Object.keys(convExtensionTools).length > 0) {
      for (const toolName of [...allowed]) {
        const owner = toolOwner.get(toolName);
        if (!owner) continue;
        const convSubset = convExtensionTools[owner.extId];
        if (!convSubset) continue; // no narrowing
        if (
          convSubset.length === 0 || // extension toggled off
          (!convSubset.includes(toolName) &&
            !convSubset.includes(owner.originalName))
        ) {
          allowed.delete(toolName);
        }
      }
    }

    // Conv toggles for extensions OUTSIDE the mode allowlist (orchestration-
    // exempt extensions like ask-user ride through applyToolFilters'
    // allowlist layer, so deleting from `allowed` can't touch them). The
    // force-denials carry every conv exclusion; overlap with the allowlist
    // removal above is harmless.
    const forceDeniedTools = computeConvDenials(convExtensionTools, registry);
    return {
      toolRestriction: "allowlist",
      allowedTools: [...allowed],
      ...(forceDeniedTools.length > 0 ? { forceDeniedTools } : {}),
    };
  }

  // ── No mode allowlist: conversation narrowing as a deny-list ──
  // The conv map's exclusions become FORCE-denials: they are explicit
  // per-conversation user toggles, the one layer allowed to remove even
  // ORCHESTRATION_TOOLS (e.g. switching ask-user off for this chat).
  const forceDeniedTools = computeConvDenials(convExtensionTools, registry);

  if (mode?.toolRestriction) {
    return {
      toolRestriction: mode.toolRestriction,
      allowedTools: mode.allowedTools ?? undefined,
      ...(forceDeniedTools.length > 0 ? { forceDeniedTools } : {}),
    };
  }

  return forceDeniedTools.length > 0 ? { forceDeniedTools } : null;
}

/**
 * Compile the conversation's extensionTools map into the list of
 * (namespaced) tool names it excludes. Each extension key denies the
 * registered tools its subset omits: an EMPTY subset (master toggle OFF)
 * denies ALL of that extension's tools; a non-empty subset denies the
 * others (matching either name form). Extensions absent from the map —
 * and tools not owned by any keyed extension — are never denied, so the
 * result is narrow-only by construction.
 */
function computeConvDenials(
  convExtensionTools: Record<string, string[]> | null | undefined,
  registry: ModeScopeRegistry,
): string[] {
  const denied: string[] = [];
  if (!convExtensionTools) return denied;
  for (const [extId, subset] of Object.entries(convExtensionTools)) {
    if (!subset) continue; // absent = all
    for (const t of registry.getToolsForExtension(extId)) {
      if (
        subset.length === 0 || // extension toggled off
        (!subset.includes(t.name) && !subset.includes(t.originalName))
      ) {
        denied.push(t.name);
      }
    }
  }
  return denied;
}
