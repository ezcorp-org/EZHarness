/**
 * Print the Playwright CLI file-filter args for one lane of the e2e lane
 * manifest (web/e2e/lanes.json) — one ANCHORED regex per line.
 *
 * ci.yml's `E2E (mock, no Docker)` job consumes `mock-gate` via
 *   mapfile -t ARGS < <(bun scripts/e2e-lane-args.ts mock-gate)
 * so the blocking spec list has exactly ONE home: the manifest. (Playwright
 * file args are REGEXES — an unanchored `hub.spec.ts` once silently pulled
 * github-projects-hub + project-hub into the blocking gate; anchoring is
 * load-bearing.) src/__tests__/e2e-lanes.test.ts pins this generator's
 * output against the manifest and ci.yml's invocation of it.
 */
import lanesManifest from "../web/e2e/lanes.json";

export function laneArgs(lanes: Record<string, string[]>, lane: string): string[] {
  const members = lanes[lane];
  if (!members || members.length === 0) {
    throw new Error(`lane '${lane}' is missing/empty in web/e2e/lanes.json`);
  }
  return members.map((path) => {
    if (!path.startsWith("web/e2e/") || !path.endsWith(".spec.ts")) {
      throw new Error(`lane '${lane}' entry '${path}' is not a web/e2e/**.spec.ts path`);
    }
    // web-relative (playwright runs from web/), dots escaped, end-anchored.
    return `${path.slice("web/".length).replace(/\./g, "\\.")}$`;
  });
}

if (import.meta.main) {
  const lane = process.argv[2];
  if (!lane) {
    console.error("usage: bun scripts/e2e-lane-args.ts <lane>");
    process.exit(2);
  }
  for (const arg of laneArgs(lanesManifest.lanes, lane)) console.log(arg);
}
