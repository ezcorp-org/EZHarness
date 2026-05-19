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

import {
  classifyFetch,
  parsePermittedHosts,
  parseToolCaps,
} from "./network-wrapper";

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

// Phase 3: filesystem primitives are ALWAYS poisoned in the subprocess
// — granted access flows through `ezcorp/fs.{read,write,list,stat,...}`
// reverse-RPC, host-mediated. The `EZCORP_FS_ALLOWED` flag is purely
// informational for SDK helper fast-fail and does NOT toggle the
// deniers (unlike `network`/`shell` where granted access also unblocks
// the in-sandbox primitive wrapped by a fetch allowlist). See
// `tasks/phase-3-filesystem-hardening.md` "Important" note + plan
// pillar 6.
const FS_MODULES = ["fs", "fs/promises"] as const;

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
} else {
  // Network IS granted — but the grant is per-host, not blanket. Wrap
  // `globalThis.fetch` so every call is gated against the spawn-time
  // allowlist (`EZCORP_PERMITTED_HOSTS`) AND the per-tool override
  // (`EZCORP_TOOL_NETWORK_CAPS`) read via the SDK's ALS tool context.
  //
  // Internal hosts (localhost / RFC-1918 / link-local) are forwarded
  // to the host via `ezcorp/network.internal` — the host PDP enforces
  // and performs the fetch host-side (SSRF carve-out).
  installFetchWrapper();
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

// Phase 3: fs primitives are ALWAYS poisoned in the subprocess —
// granted access does NOT unblock raw in-sandbox primitives. All IO
// flows through `ezcorp/fs.{read,write,list,stat,exists,mkdir,unlink}`
// reverse-RPC (see `src/extensions/fs-handler.ts`) so the host
// performs the realpath check + actual IO + audit log emission. This
// closes the TOCTOU window between the old `ezcorp/fs` path-check and
// the subprocess's `Bun.file().text()`, AND the bypass where an
// extension that ignored the SDK helper just called the primitive
// directly. The new SDK helpers (`@ezcorp/sdk/runtime/fs.fsRead/...`)
// route to the host-mediated path. See plan pillar 6.
//
// The `EZCORP_FS_ALLOWED` env var is informational only — it tells
// SDK helpers that the reverse-RPC is meaningful for this extension
// (fail-fast with a clean "no fs grant" error before round-tripping
// to the host). The deniers below fire regardless of that flag.
for (const mod of FS_MODULES) {
  poisonModule(mod, "filesystem");
  registerBlockedRequire(mod);
}
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  const BunNs = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
  BunNs.file = makeDenier(
    "filesystem",
    "Bun.file — use @ezcorp/sdk/runtime fsRead / fsExists",
  );
  BunNs.write = makeDenier(
    "filesystem",
    "Bun.write — use @ezcorp/sdk/runtime fsWrite",
  );
  BunNs.glob = makeDenier(
    "filesystem",
    "Bun.glob — use @ezcorp/sdk/runtime fsList",
  );
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

// Phase 2: `process.binding` is Node's internal C++ binding bridge —
// not part of the public API and never granted to extensions. Bun
// implements it as a function that throws "not implemented" for most
// names (tcp_wrap, udp_wrap, tls_wrap, pipe_wrap, spawn_sync, crypto),
// but several names ARE reachable in current Bun and return real
// objects:
//   - `fs`       → fs primitives (filesystem escape past Bun.file / node:fs poison)
//   - `natives`  → loads internal Node modules by name (escape vector)
//   - `util`     → introspection (lower risk, but no manifest surface)
//   - `config`   → build flags (lower risk)
//
// Architectural-plan pillar 4 explicitly listed `process.binding` as
// an escape route to close in Phase 2. The initial implementation
// missed it (auditor C4).
//
// IMPORTANT: we cannot replace `process.binding` outright because
// Bun's `require('http')` and other built-in module loaders call
// `process.binding` internally during normal initialization. An
// outright-deny breaks `require('http')` even when network IS granted.
// Instead, wrap with a denylist for names that grant capability the
// manifest doesn't surface. Other names pass through to the real
// binding (preserving Bun's "not implemented" throws AND the legitimate
// runtime-internal calls that happen during require).
if (
  typeof process !== "undefined" &&
  typeof (process as { binding?: unknown }).binding === "function"
) {
  const DENIED_BINDINGS = new Set<string>(["fs", "natives", "util", "config"]);
  const procAny = process as unknown as Record<string, unknown>;
  const origBinding = (procAny.binding as (name: string) => unknown).bind(process);
  procAny.binding = function patchedBinding(name: string): unknown {
    if (typeof name === "string" && DENIED_BINDINGS.has(name)) {
      throw new Error(
        `Extension sandbox: 'process.binding(${JSON.stringify(name)})' blocked — internal Node API not exposed to extensions`,
      );
    }
    return origBinding(name);
  };
}

/**
 * Install the per-host + per-tool fetch allowlist wrapper.
 *
 * Called only when `EZCORP_NETWORK_ALLOWED=1` — the no-network branch
 * already replaced `globalThis.fetch` with an outright denier above.
 *
 * The wrapper:
 *   1. Captures the original fetch (the real Bun builtin).
 *   2. Reads `EZCORP_PERMITTED_HOSTS` + `EZCORP_TOOL_NETWORK_CAPS` once
 *      at install time. The host populates these at spawn — no live
 *      reload needed.
 *   3. For every fetch, classifies via `classifyFetch` and routes:
 *      - `invalid`  → throw
 *      - `internal` → reverse-RPC `ezcorp/network.internal`
 *      - `deny`     → throw with the wrapper's reason
 *      - `external` → forward to original fetch
 *
 * The active tool name is read via the SDK's `getToolContext()` (ALS).
 * The SDK is part of the extension's own module graph — by the time
 * the wrapper runs (post-import-time, when the extension calls
 * `fetch(...)`), the SDK is loaded. We do a dynamic `import(...)` to
 * keep the preload itself zero-dep on the SDK.
 */
function installFetchWrapper(): void {
  const PERMITTED_HOSTS = parsePermittedHosts(process.env.EZCORP_PERMITTED_HOSTS);
  const TOOL_CAPS = parseToolCaps(process.env.EZCORP_TOOL_NETWORK_CAPS);

  const originalFetch = globalThis.fetch.bind(globalThis);

  // Lazy import — the SDK is part of the extension's module graph.
  // First-time fetch pays a one-time import cost; subsequent calls
  // reuse the cached module. Awaiting this before each fetch keeps the
  // wrapper tolerant of an extension that calls fetch at module init
  // (before the SDK has been imported by the extension's main entry).
  type ToolContextMod = {
    getToolContext?: () => { toolName?: string } | undefined;
  };
  let cachedToolContextMod: ToolContextMod | undefined;
  let toolContextLoaded = false;

  async function readToolName(): Promise<string | undefined> {
    if (!toolContextLoaded) {
      toolContextLoaded = true;
      try {
        cachedToolContextMod = (await import(
          "@ezcorp/sdk/runtime"
        )) as unknown as ToolContextMod;
      } catch {
        // SDK not installed (e.g. a test extension that bypasses the
        // SDK). Treat as ALS-unset — fall back to extension-wide ceiling.
        cachedToolContextMod = {};
      }
    }
    return cachedToolContextMod?.getToolContext?.()?.toolName;
  }

  /**
   * Dynamically import the SDK channel and call the host-side
   * `ezcorp/network.internal` handler. Reconstruct a Response from the
   * `{status, headers, body}` JSON the host returns. The body is
   * base64-encoded — the host caps response size at 10MB.
   */
  async function internalFetchViaRpc(
    urlStr: string,
    init?: RequestInit,
  ): Promise<Response> {
    const sdk = (await import("@ezcorp/sdk/runtime")) as {
      getChannel?: () => {
        request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
      };
    };
    if (!sdk.getChannel) {
      throw new Error(
        "Extension sandbox: ezcorp/network.internal requires @ezcorp/sdk to be installed in the extension's module graph",
      );
    }
    const ch = sdk.getChannel();
    // Forward the init body as-is via JSON-RPC. Bodies that are streams
    // / FormData / Blob aren't supported on the internal lane in
    // Phase 2 (the JSON-RPC transport doesn't carry binary frames yet —
    // Phase 3 adds that). For Phase 2, methods + headers + string bodies
    // cover the common cases (DB ping, internal API call).
    const params = {
      url: urlStr,
      init: serializeInit(init),
    };
    const result = await ch.request<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    }>("ezcorp/network.internal", params);
    const bytes = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  function serializeInit(init?: RequestInit): Record<string, unknown> | undefined {
    if (!init) return undefined;
    const out: Record<string, unknown> = {};
    if (init.method) out.method = init.method;
    if (init.headers) {
      // Headers may be a Headers instance, plain object, or [k,v][] —
      // normalize to a plain record.
      if (init.headers instanceof Headers) {
        const h: Record<string, string> = {};
        init.headers.forEach((v, k) => {
          h[k] = v;
        });
        out.headers = h;
      } else if (Array.isArray(init.headers)) {
        const h: Record<string, string> = {};
        for (const pair of init.headers as [string, string][]) {
          h[pair[0]] = pair[1];
        }
        out.headers = h;
      } else {
        out.headers = { ...(init.headers as Record<string, string>) };
      }
    }
    if (init.body !== undefined && init.body !== null) {
      // Phase 2: only string bodies cross the reverse-RPC boundary.
      // Larger / streaming bodies for internal hosts will land in Phase 3.
      if (typeof init.body === "string") out.body = init.body;
    }
    return out;
  }

  (globalThis as { fetch: unknown }).fetch = async function wrappedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    const toolName = await readToolName();
    const decision = classifyFetch(urlStr, {
      permittedHosts: PERMITTED_HOSTS,
      toolCaps: TOOL_CAPS,
      toolName,
    });

    switch (decision.kind) {
      case "invalid":
        throw new Error(decision.reason);
      case "deny":
        throw new Error(decision.reason);
      case "internal":
        return internalFetchViaRpc(urlStr, init);
      case "external":
        return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }
  };
}

// Monkey-patch require() to throw early with a clear message before the cached
// (poisoned) module object is ever returned. This catches `require("http")` in
// user code and in transitive dependencies loaded after the preload runs.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require("module") as {
    prototype: { require: (id: string) => unknown };
    createRequire?: (filename: string | URL) => (id: string) => unknown;
  };

  function checkBlockedId(id: string): void {
    if (!blockedRequireIds.has(id)) return;
    const bare = id.replace(/^node:/, "");
    if ((NETWORK_MODULES as readonly string[]).includes(bare)) {
      makeDenier("network", `${id} module`)();
    }
    if ((SHELL_MODULES as readonly string[]).includes(bare)) {
      makeDenier("shell", `${id} module`)();
    }
    // Phase 3: filesystem modules are unconditionally poisoned (no
    // granted-permission unblock — see the FS_MODULES block above).
    if ((FS_MODULES as readonly string[]).includes(bare)) {
      makeDenier("filesystem", `${id} module`)();
    }
  }

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function patchedRequire(
    this: unknown,
    id: string,
  ): unknown {
    checkBlockedId(id);
    return originalRequire.apply(this, [id]);
  };

  // Phase 2: an extension can build a fresh require via
  // `import { createRequire } from "node:module"; const r = createRequire(import.meta.url);`.
  // The returned `r` is NOT the patched `Module.prototype.require` —
  // it's a NEW require closure created from scratch. Without patching
  // the factory, `r("http")` returns the cached (poisoned) http module
  // — which still throws on property access, but the require call
  // ITSELF doesn't throw with our permission-label message.
  // Patching the factory closes that gap.
  if (typeof Module.createRequire === "function") {
    const origCreate = Module.createRequire.bind(Module);
    Module.createRequire = (filename: string | URL): ((id: string) => unknown) => {
      const inner = origCreate(filename);
      return function patchedDerivedRequire(id: string): unknown {
        checkBlockedId(id);
        return inner(id);
      };
    };
  }
} catch {
  /* Module patch is best-effort; poisoned module objects still provide a backstop. */
}
