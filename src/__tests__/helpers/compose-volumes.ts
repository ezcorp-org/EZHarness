/**
 * Shared readers for the compose files' `app` service.
 *
 * Two suites hold container-side paths against the code that computes them
 * — `compose-extension-state-root.test.ts` (extension state vs
 * `getProjectRoot()`) and `compose-projects-root.test.ts` (project
 * workspaces vs the fs-API sandbox root and Vite's watch ignores). Both
 * need the same four accessors; they live here so a change to compose's
 * shape is absorbed in one place.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

interface ComposeService {
  volumes?: string[];
  /** Compose accepts both `- KEY=value` (sequence) and `KEY: value` (mapping). */
  environment?: string[] | Record<string, string | null>;
}

async function appService(relPath: string): Promise<ComposeService> {
  const text = await Bun.file(join(ROOT, relPath)).text();
  const compose = Bun.YAML.parse(text) as {
    services?: Record<string, ComposeService>;
  };
  const app = compose.services?.app;
  if (!app) throw new Error(`${relPath} has no 'app' service`);
  return app;
}

/** The `app` service's volume list. Throws if the service has none. */
export async function appVolumes(relPath: string): Promise<string[]> {
  const vols = (await appService(relPath)).volumes;
  if (!vols) throw new Error(`${relPath} 'app' service declares no volumes`);
  return vols;
}

/**
 * Like `appVolumes`, but `[]` when the service declares none.
 *
 * An OVERLAY compose file legitimately contributes no volumes —
 * `compose.prod.localtest.yml` stopped needing a projects mount once the
 * base prod file carried one. A "nothing targets X" sweep has to be able to
 * read such a file without treating the absence as an error, which is
 * exactly the case where the strict reader would throw.
 */
export async function appVolumesOrEmpty(relPath: string): Promise<string[]> {
  return (await appService(relPath)).volumes ?? [];
}

/**
 * The `app` service's environment as a map.
 *
 * Compose accepts BOTH shapes and this repo uses both — `docker-compose.yml`
 * writes the sequence form (`- KEY=value`), `compose.prod.yml` writes the
 * mapping form (`KEY: value`). Reading only the sequence form threw
 * `TypeError: {} is not iterable` on the prod file, so a caller asking prod
 * for `EZCORP_PROJECT_ROOT` could not get an answer at all.
 *
 * In the sequence form a bare `- KEY` (pass-through from the host) maps to
 * `undefined`, which is distinct from a key that is absent entirely; the
 * mapping form spells the same thing `KEY:` (null value).
 */
export async function appEnv(relPath: string): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  const env = (await appService(relPath)).environment;
  if (!env) return out;

  if (Array.isArray(env)) {
    for (const entry of env) {
      const eq = entry.indexOf("=");
      if (eq === -1) out.set(entry, undefined);
      else out.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return out;
  }

  for (const [key, value] of Object.entries(env)) {
    out.set(key, value == null ? undefined : String(value));
  }
  return out;
}

/**
 * Split one compose short-syntax mount into its colon-separated fields,
 * IGNORING colons inside a `${…}` interpolation.
 *
 * A naive `split(":")` is wrong the moment a mount uses a default:
 *
 *   "${EZCORP_TEST_PROJECTS_DIR:-./projects}:/app/projects".split(":")
 *     → ["${EZCORP_TEST_PROJECTS_DIR", "-./projects}", "/app/projects"]
 *
 * so the source is truncated, the TARGET comes back as the source's tail,
 * and any assertion written against it passes while testing nothing. No
 * compose file in the repo interpolates a mount today (the last one went
 * away with the `/app/projects` bind in PR #153), which is exactly why this
 * needs to be handled here rather than discovered by the next person who
 * adds one.
 */
export function splitMount(entry: string): string[] {
  const fields: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i]!;
    if (ch === "$" && entry[i + 1] === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    if (ch === ":" && depth === 0) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

/**
 * Target (container) side of the bind whose source is `source`. Compose
 * short syntax is `<source>:<target>[:<mode>]`.
 */
export function targetOf(volumes: readonly string[], source: string): string | undefined {
  for (const v of volumes) {
    const [src, target] = splitMount(v);
    if (src === source) return target;
  }
  return undefined;
}

/** ALL targets for `source` — some sources are deliberately bound twice. */
export function targetsOf(volumes: readonly string[], source: string): string[] {
  const out: string[] = [];
  for (const v of volumes) {
    const [src, target] = splitMount(v);
    if (src === source && target) out.push(target);
  }
  return out;
}

/** Every container-side path in the list (for "nothing targets X" checks). */
export function targets(volumes: readonly string[]): string[] {
  return volumes.map((v) => splitMount(v)[1] ?? "");
}
