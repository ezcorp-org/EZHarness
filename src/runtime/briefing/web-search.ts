/**
 * Daily Briefing — web-search extension wiring for the watchlist
 * section (Phase 3, spec §5.2 / §8).
 *
 * Two responsibilities, both fail-soft (a throw anywhere degrades to
 * "web search unavailable" — the run proceeds with a watchlist-skipped
 * note, never an error in the user's face):
 *
 *   1. `resolveBriefingWebSearch()` — is the `web-search` example
 *      extension installed AND enabled, and which namespaced tool
 *      names does it expose? Names are derived from the stored
 *      manifest (`<manifest.name>__<tool.name>` — the registry's
 *      namespacing scheme, see ExtensionRegistry.loadFromDb), so a
 *      future tool addition flows through without touching this file.
 *
 *   2. `syncBriefingAgentWebSearch()` — keep the shared "Daily
 *      Briefing" agent config's `extensions` / `extensionTools`
 *      references in lock-step with the extension's presence, so
 *      setup-tools' agent-config extension path (2b) loads the tools
 *      for the scheduled run. Installed+enabled → referenced (scoped
 *      to exactly the manifest's tool subset); missing/disabled →
 *      reference removed. Only the web-search id is ever touched —
 *      any other reference on the row is preserved verbatim.
 *
 * Security: the tools the run actually receives still pass through
 * `toolRestriction: 'read-only'`; the pipeline vouches for ONLY these
 * namespaced names via `readOnlyAllowedTools` (see tools/filter.ts).
 * The write/execute exclusion is untouched.
 */
import { getExtensionByName } from "../../db/queries/extensions";
import { updateAgentConfig, type DbAgentConfig } from "../../db/queries/agent-configs";
import { logger } from "../../logger";

const log = logger.child("briefing.web-search");

export const WEB_SEARCH_EXTENSION_NAME = "web-search";

export interface BriefingWebSearch {
  /** Installed + enabled + at least one declared tool. */
  available: boolean;
  /** The extension row's id when available (agent-config reference target). */
  extensionId: string | null;
  /** Namespaced tool names (`web-search__search-web`, …); empty when unavailable. */
  toolNames: string[];
}

const UNAVAILABLE: BriefingWebSearch = { available: false, extensionId: null, toolNames: [] };

/**
 * Detect the web-search extension and derive its namespaced tool names.
 * Never throws — DB/manifest pathologies degrade to "unavailable".
 */
export async function resolveBriefingWebSearch(): Promise<BriefingWebSearch> {
  try {
    const ext = await getExtensionByName(WEB_SEARCH_EXTENSION_NAME);
    if (!ext?.enabled) return UNAVAILABLE;
    const manifestName = ext.manifest?.name ?? WEB_SEARCH_EXTENSION_NAME;
    const toolNames = (ext.manifest?.tools ?? [])
      .filter((t) => typeof t?.name === "string" && t.name.length > 0)
      .map((t) => `${manifestName}__${t.name}`);
    if (toolNames.length === 0) return UNAVAILABLE;
    return { available: true, extensionId: ext.id, toolNames };
  } catch (err) {
    log.warn("web-search resolution failed — watchlist research unavailable", {
      error: String(err),
    });
    return UNAVAILABLE;
  }
}

/**
 * Reconcile the shared briefing agent config's extension references
 * with the web-search extension's presence. No-op when already in
 * sync (the common case — one cheap array comparison per run).
 */
export async function syncBriefingAgentWebSearch(
  agent: DbAgentConfig,
  webSearch: BriefingWebSearch,
): Promise<void> {
  try {
    const current = (agent.extensions as string[] | null) ?? [];
    const currentTools = (agent.extensionTools as Record<string, string[]> | null) ?? {};

    if (webSearch.available && webSearch.extensionId) {
      const id = webSearch.extensionId;
      const wantedSubset = webSearch.toolNames;
      const alreadyReferenced = current.includes(id);
      const subsetInSync =
        JSON.stringify(currentTools[id] ?? []) === JSON.stringify(wantedSubset);
      if (alreadyReferenced && subsetInSync) return;
      await updateAgentConfig(agent.id, {
        extensions: alreadyReferenced ? current : [...current, id],
        extensionTools: { ...currentTools, [id]: wantedSubset },
      } as Parameters<typeof updateAgentConfig>[1]);
      log.info("briefing agent web-search reference synced", { extensionId: id });
      return;
    }

    // Unavailable: drop a stale reference if one exists. We cannot know
    // the (now deleted) extension's id, so remove any id whose
    // extensionTools subset looks like ours OR simply leave non-matching
    // references alone — a dangling id is harmless (getToolsForAgent
    // skips unknown ids) but tidying keeps the row honest when the
    // extension row still exists disabled.
    const ext = await getExtensionByName(WEB_SEARCH_EXTENSION_NAME);
    if (!ext) return; // row gone — any leftover id is inert; nothing to key off
    if (!current.includes(ext.id)) return;
    const nextTools = { ...currentTools };
    delete nextTools[ext.id];
    await updateAgentConfig(agent.id, {
      extensions: current.filter((e) => e !== ext.id),
      extensionTools: nextTools,
    } as Parameters<typeof updateAgentConfig>[1]);
    log.info("briefing agent web-search reference removed (extension disabled)", {
      extensionId: ext.id,
    });
  } catch (err) {
    // Fail-soft: a sync failure must never fail the briefing run; the
    // worst case is a stale tool surface for one fire.
    log.warn("briefing agent web-search sync failed", { error: String(err) });
  }
}
