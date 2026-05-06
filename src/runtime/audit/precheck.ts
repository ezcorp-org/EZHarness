import { join } from "node:path";
import type { FeatureWithFiles } from "../../db/queries/features";
import type { SurfaceVerdict } from "../../db/schema";

/**
 * Deterministic surface-classification rules. Returns a partial verdict —
 * each surface is set ONLY if the rules can decide it; missing keys fall
 * through to the LLM. Precheck always wins on conflict (see run.ts) so
 * the rules below must be conservative — only set `exposed: true` when
 * the file evidence is unambiguous, and only set `exposed: false` when
 * we're confident the surface is genuinely missing.
 *
 * Caps mirror src/runtime/scan/feature-scan.ts:71-73 — read no more than
 * 200 files per feature, 64 KiB per file when grepping for tokens.
 */

export type PartialVerdict = Partial<{
  sdk: SurfaceVerdict;
  ezbutton: SurfaceVerdict;
  mcp: SurfaceVerdict;
}>;

const PRECHECK_MAX_FILES_READ = 200;
const PRECHECK_MAX_FILE_BYTES = 64_000;

/** Filename extensions that are never worth grepping. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bin", ".lock", ".woff", ".woff2",
  ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov",
]);

function getExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function pathMatches(relpath: string, ...needles: string[]): boolean {
  return needles.some((n) => relpath.includes(n));
}

/**
 * Run path-only rules first (no file IO). For tokens that need
 * content evidence, defer to a content-grep pass over a capped subset
 * of files.
 */
export async function runPrecheck(
  feature: FeatureWithFiles,
  projectRoot: string,
): Promise<PartialVerdict> {
  const verdict: PartialVerdict = {};
  const relpaths = feature.files.map((f) => f.relpath);

  // ── Path-only rules (cheap, no IO) ─────────────────────────────────

  // SDK: any ezcorp.config.{ts,js,mjs} or anything under packages/@ezcorp/sdk.
  // An ezcorp.config.{ts,js,mjs} file identifies the feature as a published
  // extension, which is also reachable through the MCP `extension_search`
  // meta-tool — so stamp MCP=true via precheck too. The
  // `packages/@ezcorp/sdk/` branch is the SDK source itself (not an
  // extension), so it only implies SDK exposure.
  for (const rp of relpaths) {
    const isExtensionManifest = /(^|\/)ezcorp\.config\.(ts|js|mjs)$/.test(rp);
    const isSdkSource = pathMatches(rp, "packages/@ezcorp/sdk/");
    if (isExtensionManifest || isSdkSource) {
      verdict.sdk = { exposed: true, via: "precheck", evidence: rp };
      if (isExtensionManifest) {
        verdict.mcp = {
          exposed: true,
          via: "precheck",
          evidence: `${rp}: covered by extension_search MCP meta-tool`,
        };
      }
      break;
    }
  }

  // EzButton (path rule): any *.svelte under web/src/lib/components/ez/
  for (const rp of relpaths) {
    if (rp.includes("web/src/lib/components/ez/") && rp.endsWith(".svelte")) {
      verdict.ezbutton = { exposed: true, via: "precheck", evidence: rp };
      break;
    }
  }

  // MCP (path rule): anything under packages/@ezcorp/ai-kit/src/mcp/
  for (const rp of relpaths) {
    if (pathMatches(rp, "packages/@ezcorp/ai-kit/src/mcp/")) {
      verdict.mcp = { exposed: true, via: "precheck", evidence: rp };
      break;
    }
  }

  // ── Content-grep rules (only for surfaces still undecided) ────────

  const needsEzbuttonGrep = !verdict.ezbutton;
  const needsMcpGrep = !verdict.mcp;
  if (!needsEzbuttonGrep && !needsMcpGrep) return verdict;

  let filesRead = 0;
  for (const rp of relpaths) {
    if (filesRead >= PRECHECK_MAX_FILES_READ) break;
    if (BINARY_EXTENSIONS.has(getExt(rp))) continue;
    if (verdict.ezbutton && verdict.mcp) break;

    const abs = join(projectRoot, rp);
    let head: string;
    try {
      const file = Bun.file(abs);
      const exists = await file.exists();
      if (!exists) continue;
      // Slice to cap memory before reading text.
      const slice = file.slice(0, PRECHECK_MAX_FILE_BYTES);
      head = await slice.text();
    } catch {
      continue;
    }
    filesRead += 1;

    // Note: the previous `<EzContext>` precheck heuristic was retired
    // alongside the page-context-pushing mechanism. The ezbutton verdict
    // now relies on the LLM classifier alone.
    if (!verdict.mcp && rp.includes("/mcp/") && head.includes("server.tool(")) {
      verdict.mcp = { exposed: true, via: "precheck", evidence: `${rp}: server.tool(` };
    }
  }

  return verdict;
}

/**
 * Promote a partial verdict to a full verdict by filling in any
 * remaining surfaces with `exposed: false, via: "precheck"`. Used
 * when the LLM step is skipped (every surface decided by precheck)
 * or as a fallback when the LLM call fails.
 */
export function asFullVerdict(partial: PartialVerdict): {
  sdk: SurfaceVerdict;
  ezbutton: SurfaceVerdict;
  mcp: SurfaceVerdict;
} {
  return {
    sdk: partial.sdk ?? { exposed: false, via: "precheck", evidence: "no precheck signal" },
    ezbutton: partial.ezbutton ?? { exposed: false, via: "precheck", evidence: "no precheck signal" },
    mcp: partial.mcp ?? { exposed: false, via: "precheck", evidence: "no precheck signal" },
  };
}
