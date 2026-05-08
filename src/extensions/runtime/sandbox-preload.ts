/**
 * Extension subprocess sandbox preload.
 *
 * Loaded via `bun --preload` before the extension entrypoint runs. Restricts
 * Node module imports and global APIs so extensions cannot bypass declared
 * permissions to reach the network or spawn shells.
 *
 * Activation is controlled by env vars set by `subprocess.ts`:
 *   EZCORP_NETWORK_ALLOWED=1 — extension has `network` permission, leave network
 *                             modules alone. If unset, block http/https/net/…
 *   EZCORP_SHELL_ALLOWED=1   — extension has `shell` permission, leave
 *                             child_process + Bun.spawn alone. If unset, block.
 *
 * Blocking strategy (per module):
 *   1. Eagerly require the module and rewrite every own property into a
 *      throwing getter. This catches dynamic `import()` of builtin modules
 *      (Bun.plugin cannot override builtins via `build.module`).
 *   2. Monkey-patch `Module.prototype.require` so a plain `require("http")`
 *      throws before the cached module object is returned.
 *   3. Override globals that offer equivalent capability (e.g. `fetch`,
 *      `Bun.spawn`).
 */

const NETWORK_MODULES = [
  "http",
  "https",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
] as const;

const SHELL_MODULES = ["child_process"] as const;

const networkAllowed = process.env.EZCORP_NETWORK_ALLOWED === "1";
const shellAllowed = process.env.EZCORP_SHELL_ALLOWED === "1";

function makeDenier(permission: string, what: string): () => never {
  return () => {
    throw new Error(
      `Extension sandbox: '${what}' blocked — extension requires '${permission}' permission ` +
        `(add to manifest.permissions.${permission} and grant at install time)`,
    );
  };
}

/**
 * Constructor-style denier. Plain functions (not arrow functions) can
 * be called with `new`, so this is what we use to deny `WebSocket`,
 * `Worker`, and `EventSource` — the runtime would otherwise throw a
 * generic "function is not a constructor" error before the body runs,
 * which doesn't carry our permission-label message.
 *
 * Phase 2: only used for class-shaped globals where extension code
 * reaches via `new X(...)`. Method-shaped APIs (`Bun.connect(...)`,
 * `fetch(...)`, etc.) keep using `makeDenier` since they're never
 * `new`-called.
 */
function makeCtorDenier(permission: string, what: string): unknown {
  return function DeniedCtor(): never {
    throw new Error(
      `Extension sandbox: '${what}' blocked — extension requires '${permission}' permission ` +
        `(add to manifest.permissions.${permission} and grant at install time)`,
    );
  };
}

/**
 * Replace every own property of a builtin module object with a throwing getter.
 * This catches `import http from "http"` / `await import("http")` because Bun
 * caches the same module object for both CJS and ESM access.
 */
function poisonModule(modName: string, permission: string): void {
  let mod: Record<string, unknown>;
  try {
    mod = require(modName);
  } catch {
    // Module may already be poisoned (e.g. `https` transitively requires `http`)
    // or unavailable; either way there is nothing to poison.
    return;
  }
  const deny = makeDenier(permission, `${modName} module`);
  for (const key of Object.getOwnPropertyNames(mod)) {
    try {
      Object.defineProperty(mod, key, {
        get: deny,
        set: () => {
          /* ignore writes */
        },
        configurable: false,
      });
    } catch {
      /* non-configurable properties cannot be overridden; best effort */
    }
  }
}

const blockedRequireIds = new Set<string>();

function registerBlockedRequire(modName: string): void {
  blockedRequireIds.add(modName);
  blockedRequireIds.add("node:" + modName);
}

if (!networkAllowed) {
  for (const mod of NETWORK_MODULES) {
    poisonModule(mod, "network");
    registerBlockedRequire(mod);
  }
  // fetch is a global alias for http/https client capability
  (globalThis as unknown as { fetch: unknown }).fetch = makeDenier(
    "network",
    "fetch()",
  );
  // Phase 2: Bun's native socket / server primitives bypass Node's
  // network modules entirely. An extension granted nothing must not
  // be able to dial out by reaching for Bun.connect / Bun.listen /
  // Bun.serve / Bun.udpSocket. WebSocket and EventSource are global
  // classes for client-side streaming connections — independent of the
  // Bun namespace — so they're denied on `globalThis`.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const BunNs = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
    BunNs.connect = makeDenier("network", "Bun.connect");
    BunNs.listen = makeDenier("network", "Bun.listen");
    BunNs.serve = makeDenier("network", "Bun.serve");
    BunNs.udpSocket = makeDenier("network", "Bun.udpSocket");
  }
}

// Phase 2: WebSocket / EventSource / Worker are ALWAYS denied in
// Phase 2, even with `network` granted. They need streaming +
// Worker-preload-propagation work that's not in Phase 2's scope —
// see the spec's "Out of scope" section. A future phase may add
// host-mediated alternatives.
//
// These are class-shaped globals — extensions construct with `new X(...)`,
// so we use `makeCtorDenier` to ensure our permission-label message is
// what surfaces, not the runtime's generic "function is not a constructor".
(globalThis as Record<string, unknown>).WebSocket = makeCtorDenier(
  "network",
  "WebSocket — host-mediated streaming alternative is a future phase",
);
if ((globalThis as Record<string, unknown>).EventSource !== undefined) {
  (globalThis as Record<string, unknown>).EventSource = makeCtorDenier(
    "network",
    "EventSource — host-mediated streaming alternative is a future phase",
  );
}

if (!shellAllowed) {
  for (const mod of SHELL_MODULES) {
    poisonModule(mod, "shell");
    registerBlockedRequire(mod);
  }
  // Bun's native spawn bypasses Node's child_process entirely, so we have to
  // deny it on the Bun global as well.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const BunNs = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
    BunNs.spawn = makeDenier("shell", "Bun.spawn");
    BunNs.spawnSync = makeDenier("shell", "Bun.spawnSync");
    // Bun.$ is a tagged-template shell — same capability as spawn.
    BunNs.$ = makeDenier("shell", "Bun.$");
  }
}

// Always deny — extension manifest has no concept of FFI or Worker
// permission. FFI gives unrestricted native code execution. Workers
// spawn fresh module graphs that may not run --preload, breaking the
// sandbox's invariants. If/when extensions need worker-style parallelism
// or FFI, a host-mediated alternative will land in a future phase.
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  const BunNs = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
  BunNs.dlopen = makeDenier(
    "native",
    "Bun.dlopen — FFI is never granted to extensions",
  );
}
(globalThis as Record<string, unknown>).Worker = makeCtorDenier(
  "native",
  "Worker — extension subprocess cannot spawn workers",
);

// Monkey-patch require() to throw early with a clear message before the cached
// (poisoned) module object is ever returned. This catches `require("http")` in
// user code and in transitive dependencies loaded after the preload runs.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require("module") as {
    prototype: { require: (id: string) => unknown };
  };
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function patchedRequire(
    this: unknown,
    id: string,
  ): unknown {
    if (blockedRequireIds.has(id)) {
      const bare = id.replace(/^node:/, "");
      if ((NETWORK_MODULES as readonly string[]).includes(bare)) {
        makeDenier("network", `${id} module`)();
      }
      if ((SHELL_MODULES as readonly string[]).includes(bare)) {
        makeDenier("shell", `${id} module`)();
      }
    }
    return originalRequire.apply(this, [id]);
  };
} catch {
  /* Module patch is best-effort; poisoned module objects still provide a backstop. */
}
