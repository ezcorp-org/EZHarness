#!/usr/bin/env bun
/**
 * ez-factory — the sandboxed subprocess entrypoint.
 *
 * At 8.4 this file is exactly one thing: the binding between the host's
 * reverse-RPC filesystem surface and the three pure tool factories under
 * `lib/tools/`. The Hub page renderers (`definePage`) land in 8.6 and
 * mount alongside the dispatcher here.
 *
 * ── Why every fs call is a host round trip ─────────────────────────────
 *
 * `src/extensions/runtime/sandbox-preload.ts` poisons `node:fs`,
 * `fs/promises`, `Bun.file`, `Bun.write` and `Bun.glob` at load. That is
 * not advice: the host realpaths each path BEFORE the PDP authorizes it,
 * which is what closes the TOCTOU window a subprocess-side `Bun.file()`
 * would reopen. `tools.grep.test.ts` asserts mechanically that no file
 * under `extensions/ez-factory/**` reaches for any of them.
 *
 * `Bun.Glob` is the one Bun API the tools do use, and it is untouched by
 * the preload for a good reason: `new Bun.Glob(p).match(s)` is pure string
 * matching over a path the host already handed us. It is `Bun.glob`,
 * the lowercase directory-SCANNING helper, that is poisoned.
 */
import {
  createToolDispatcher,
  fsExists,
  fsList,
  fsMkdir,
  fsRead,
  fsStat,
  fsWrite,
  getChannel,
  getToolContext,
} from "@ezcorp/sdk/runtime";

import { createFactoryToolHandlers } from "./lib/tools";
import type { FactoryFs, ToolDeps } from "./lib/tools/shared";

/**
 * The host-mediated filesystem, adapted to the narrow surface the tools
 * declare. Thin on purpose — anything with a decision in it belongs in
 * `lib/`, where it is covered.
 */
export const hostFs: FactoryFs = {
  list: (path) => fsList(path),
  stat: async (path) => ({ size: (await fsStat(path)).size }),
  read: async (path) => {
    const body = await fsRead(path, { encoding: "utf-8" });
    // `fsRead` is typed `string | Uint8Array` because the same RPC serves
    // binary reads. utf-8 always decodes host-side, but the type is the
    // contract, so decode rather than cast.
    return typeof body === "string" ? body : new TextDecoder().decode(body);
  },
  write: async (path, content) => ({ bytes: (await fsWrite(path, content)).bytes }),
  mkdir: async (path) => {
    await fsMkdir(path, { recursive: true });
  },
  exists: (path) => fsExists(path),
};

/**
 * Filesystem root of the ACTIVE project.
 *
 * Per-call first: one persistent subprocess serves every conversation, so
 * the process-wide `EZCORP_PROJECT_ROOT` names only ever ONE project and
 * is a last resort for out-of-band dispatches (a workflow tool step
 * carries a synthetic conversation with no project to resolve).
 *
 * This value is a CONVENIENCE, not a boundary. The host expands the
 * `filesystem: ["$CWD"]` grant through `grantCwdBase()` → `getProjectRoot()`
 * and authorizes against that, so a wrong value here produces a permission
 * denial, never an escape.
 */
export function activeProjectRoot(): string {
  return getToolContext()?.projectRoot ?? process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
}

export const deps: ToolDeps = { fs: hostFs, projectRoot: activeProjectRoot };

/**
 * Production boot. Exported rather than inlined under `import.meta.main`
 * so `boot.test.ts` can drive it IN-process against the SDK test channel —
 * a spawned subprocess's coverage never reaches this process's lcov. Same
 * shape as `extensions/memory-extractor/index.ts`.
 */
export function start(): void {
  createToolDispatcher(createFactoryToolHandlers(deps));
  getChannel().start();
}

// Gated on `import.meta.main` so test imports do not open stdin.
if (import.meta.main) start();
