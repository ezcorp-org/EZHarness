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
  environment?: string[];
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
 * The `app` service's environment as a map. Compose list syntax
 * (`- KEY=value`); a bare `- KEY` (pass-through from the host) maps to
 * `undefined`, which is distinct from a key that is absent entirely.
 */
export async function appEnv(relPath: string): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  for (const entry of (await appService(relPath)).environment ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) out.set(entry, undefined);
    else out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

/**
 * Target (container) side of the bind whose source is `source`. Compose
 * short syntax is `<source>:<target>[:<mode>]`.
 */
export function targetOf(volumes: readonly string[], source: string): string | undefined {
  for (const v of volumes) {
    const [src, target] = v.split(":");
    if (src === source) return target;
  }
  return undefined;
}

/** ALL targets for `source` — some sources are deliberately bound twice. */
export function targetsOf(volumes: readonly string[], source: string): string[] {
  const out: string[] = [];
  for (const v of volumes) {
    const [src, target] = v.split(":");
    if (src === source && target) out.push(target);
  }
  return out;
}

/** Every container-side path in the list (for "nothing targets X" checks). */
export function targets(volumes: readonly string[]): string[] {
  return volumes.map((v) => v.split(":")[1] ?? "");
}
