import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

/**
 * Locks the compose bind targets for extension state to the root that
 * `getProjectRoot()` actually resolves.
 *
 * This is the test that would have caught the original bug. The dev stack
 * bound host ./.ezcorp/extensions at /app/web/.ezcorp/extensions — the
 * vite-SSR dev server's `process.cwd()` — while every reader/writer of
 * extension state anchors to `getProjectRoot()`
 * (src/extensions/bundled.ts), which returns the directory that HOLDS
 * `src/`, i.e. /app. Nothing failed loudly: /app/.ezcorp existed in the
 * container's throwaway overlay, so installs "worked" until the next
 * container recreate silently wiped them, and the bind sat unwritten.
 *
 * Neither root is hardcoded here. Both are DERIVED from the compose file's
 * own source mounts, mirroring how each root is really computed:
 *
 *   projectRoot  ← dirname of the target of the `./src` bind
 *                  (getProjectRoot() resolves from an import.meta.dir
 *                  containing src/extensions, so it lands on the dir
 *                  holding src/)
 *   webCwd       ← dirname of the target of the `./web/src` bind
 *                  (the dev server runs `cd web && bun run dev`)
 *
 * So the assertions stay correct if the container layout ever moves off
 * /app, and they fail if the two roots are ever conflated again.
 *
 * The `ext-data` named volume is asserted to STAY at <webCwd>/.ezcorp: it
 * backs the genuinely cwd-anchored generated-image store and .ezcorp/data.
 * The dual-root situation is real and deliberate — this test pins which
 * subtree belongs to which root rather than collapsing them.
 */

const ROOT = join(import.meta.dir, "..", "..");

interface ComposeService {
  volumes?: string[];
}

async function appVolumes(relPath: string): Promise<string[]> {
  const text = await Bun.file(join(ROOT, relPath)).text();
  const compose = Bun.YAML.parse(text) as {
    services?: Record<string, ComposeService>;
  };
  const vols = compose.services?.app?.volumes;
  expect(vols).toBeDefined();
  return vols!;
}

/**
 * Target (container) side of the bind whose source is `source`. Compose
 * short syntax is `<source>:<target>[:<mode>]`.
 */
function targetOf(volumes: readonly string[], source: string): string | undefined {
  for (const v of volumes) {
    const [src, target] = v.split(":");
    if (src === source) return target;
  }
  return undefined;
}

/** Every container-side path in the list (for "nothing targets X" checks). */
function targets(volumes: readonly string[]): string[] {
  return volumes.map((v) => v.split(":")[1] ?? "");
}

describe("docker-compose.yml — extension state is anchored to getProjectRoot()", () => {
  test("the two roots are distinct and derived from the compose file itself", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const srcTarget = targetOf(vols, "./src");
    const webSrcTarget = targetOf(vols, "./web/src");
    expect(srcTarget).toBeDefined();
    expect(webSrcTarget).toBeDefined();
    // Sanity: the dev server's cwd is a SUBdirectory of the project root.
    // If this ever stops holding, the rest of this suite is meaningless.
    expect(dirname(webSrcTarget!)).toBe(join(dirname(srcTarget!), "web"));
  });

  test("extensions/ + extension-data/ bind under the project root, not the dev-server cwd", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const projectRoot = dirname(targetOf(vols, "./src")!);

    expect(targetOf(vols, "./.ezcorp/extensions")).toBe(
      join(projectRoot, ".ezcorp/extensions"),
    );
    expect(targetOf(vols, "./.ezcorp/extension-data")).toBe(
      join(projectRoot, ".ezcorp/extension-data"),
    );
  });

  test("no volume targets extension state under the dev-server cwd (the original bug)", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const webCwd = dirname(targetOf(vols, "./web/src")!);
    const all = targets(vols);

    expect(all).not.toContain(join(webCwd, ".ezcorp/extensions"));
    expect(all).not.toContain(join(webCwd, ".ezcorp/extension-data"));
  });

  test("the ext-data volume STAYS on the cwd-anchored root (image store + .ezcorp/data)", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const webCwd = dirname(targetOf(vols, "./web/src")!);

    expect(targetOf(vols, "ext-data")).toBe(join(webCwd, ".ezcorp"));
  });
});

describe("compose.prod.yml — same extension-state contract", () => {
  test("prod binds extension state at the project root (WORKDIR=/app)", async () => {
    const vols = await appVolumes("compose.prod.yml");

    expect(targetOf(vols, "./.ezcorp/extensions")).toBe("/app/.ezcorp/extensions");
    expect(targetOf(vols, "./.ezcorp/extension-data")).toBe(
      "/app/.ezcorp/extension-data",
    );
  });

  test("dev and prod agree on the extension-state targets (no cross-stack drift)", async () => {
    const dev = await appVolumes("docker-compose.yml");
    const prod = await appVolumes("compose.prod.yml");

    for (const source of ["./.ezcorp/extensions", "./.ezcorp/extension-data"]) {
      expect(targetOf(dev, source)).toBe(targetOf(prod, source)!);
    }
  });
});
