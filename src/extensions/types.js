// ── V2 Component Definitions ─────────────────────────────────────
export function inferPackageType(manifest) {
    const hasTools = (manifest.tools?.length ?? 0) > 0;
    const hasSkills = (manifest.skills?.length ?? 0) > 0;
    const hasMcp = (manifest.mcpServers?.length ?? 0) > 0;
    const hasScripts = manifest.scripts != null;
    const hasAgent = manifest.agent != null;
    // "agent" only if JUST an agent with no other components
    if (hasAgent && !hasTools && !hasSkills && !hasMcp && !hasScripts) {
        return "agent";
    }
    return "extension";
}
// ── Marketplace Types (moved from src/marketplace/types.ts) ──────
export const MARKETPLACE_CATEGORIES = [
    "Productivity",
    "Development",
    "Writing",
    "Research",
    "Education",
    "Creative",
    "Data & Analysis",
    "Communication",
    "Other",
];
//# sourceMappingURL=types.js.map