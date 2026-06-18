/**
 * Shared E2E "server pipeline" harness for example extensions.
 *
 * Example tests spawn an extension through the REAL `ExtensionProcess` (the
 * same class `ExtensionRegistry.getProcess` uses), but a bare
 * `new ExtensionProcess(...)` does NOT wire the host-side env grants and
 * reverse-RPC handlers that production's `ExtensionRegistry` /
 * `ToolExecutor` provide. Without them every grant-dependent tool call fails:
 *   - SDK `fsRead/fsWrite/...` short-circuit on `EZCORP_FS_ALLOWED !== "1"`,
 *     or hit "no handler wired" for the `ezcorp/fs.*` reverse-RPC;
 *   - `Bun.$` / child_process throw unless `EZCORP_SHELL_ALLOWED=1`;
 *   - `fetch` / net modules throw unless `EZCORP_NETWORK_ALLOWED=1`.
 *
 * This module provides the two host-side pieces, as PURE utilities:
 *   - `buildHarnessEnv()` mirrors `registry.ts` `buildAllowedEnv()` (env flags);
 *   - `wireFsHandler()` mirrors `ToolExecutor.ensureSubprocessRpcWired()`'s
 *     `ezcorp/fs.*` handlers — a faithful, tmp-scoped re-implementation of
 *     `src/extensions/fs-handler.ts`'s wire contract (without the host PDP,
 *     which has its own unit tests).
 *
 * IMPORTANT — no value import of `ExtensionProcess` here. Each test file
 * declares its own `mock.module("../../../../src/db/queries/extensions", …)`
 * BEFORE importing `ExtensionProcess`; a value import in this shared module
 * would pull the subprocess→db chain in ahead of that mock and break the
 * failure-counter assertions. We take an already-constructed proc instead and
 * reference its type only.
 *
 * The fs handler is faithful in one security-relevant way: `fs.write` does
 * NOT create parent directories (the real host doesn't either), so a harness
 * call exercises the same `fsMkdir`-before-`fsWrite` contract real extension
 * code must follow — rather than masking a missing-mkdir bug.
 */
import { tmpdir } from "node:os";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spyOn } from "bun:test";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import type { JsonRpcRequest, JsonRpcResponse } from "../../../../src/extensions/types";

/** Minimal structural view of `ExtensionProcess` — avoids a value import. */
interface RequestWirable {
  setRequestHandler(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void;
}

export interface HarnessGrants {
  /** Grant filesystem (sets EZCORP_FS_ALLOWED=1). Pair with `wireFsHandler`. */
  filesystem?: boolean;
  /** Grant shell (sets EZCORP_SHELL_ALLOWED=1 — also pass shellAllowed:true to the ctor). */
  shell?: boolean;
  /** Grant network (sets EZCORP_NETWORK_ALLOWED=1 — also pass networkAllowed:true to the ctor). */
  network?: boolean;
  /** Comma-joined permitted hostnames (EZCORP_PERMITTED_HOSTS). */
  permittedHosts?: string;
  /** EZCORP_PROJECT_ROOT — the resolved project root the host injects. */
  projectRoot?: string;
  /** Extra env entries (e.g. tool-specific config). */
  env?: Record<string, string>;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Build the allowed-env map the registry would emit for the given grants.
 * Base keys (PATH/HOME/NODE_ENV/TMPDIR) mirror the minimal allowlist; a
 * per-extension TMPDIR is created so concurrent procs don't collide.
 */
export function buildHarnessEnv(extensionId: string, grants: HarnessGrants = {}): Record<string, string> {
  const extTmpDir = `${tmpdir()}/ezcorp-ext/${extensionId}`;
  mkdirSync(extTmpDir, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
  if (grants.filesystem) env.EZCORP_FS_ALLOWED = "1";
  if (grants.shell) env.EZCORP_SHELL_ALLOWED = "1";
  if (grants.network) env.EZCORP_NETWORK_ALLOWED = "1";
  if (grants.permittedHosts) env.EZCORP_PERMITTED_HOSTS = grants.permittedHosts;
  if (grants.projectRoot) env.EZCORP_PROJECT_ROOT = grants.projectRoot;
  return { ...env, ...(grants.env ?? {}) };
}

/** Numeric-coded error carrier — see `runFsOp` for why the code stays numeric. */
interface FsOpError {
  code: number;
  message: string;
}
function isFsOpError(e: unknown): e is FsOpError {
  return !!e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "number";
}

/**
 * Core `ezcorp/fs.*` op against real disk, confined to `fsRoot`. Returns the
 * RESULT object the SDK client expects (base64 read bodies, `{entries}` /
 * `{exists}` / `{resolvedPath}` envelopes — mirrors `src/extensions/fs-handler.ts`).
 * Throws an `FsOpError` (NUMERIC code) on guard or IO failure.
 *
 * The numeric code is load-bearing: the SDK channel only rejects with a
 * `JsonRpcError` (vs a plain `Error`) when `error.code` is a number, and
 * extensions branch on `err instanceof JsonRpcError` (e.g. task-stack maps
 * host ENOENT → empty store). Node's errno `.code` is a STRING ("ENOENT"),
 * so we remap it to -32000 with `fs-handler.ts`'s `ioErrorMsg` shape.
 *
 * Faithful to the host in one way the harness must preserve: `fs.write` does
 * NOT create parent directories — extension code must `fsMkdir` first.
 */
function runFsOp(method: string, params: Record<string, unknown>, fsRoot: string): unknown {
  const op = method.slice("ezcorp/fs.".length);
  const p = params.path;
  if (typeof p !== "string" || p.length === 0) {
    throw { code: -32602, message: "Missing path" } satisfies FsOpError;
  }
  // Boundary-anchored containment (mirror fs-handler.ts: `=== prefix ||
  // startsWith(prefix + sep)`) so `fsRoot="/tmp"` can't admit `/tmpevil/...`.
  if (p !== fsRoot && !p.startsWith(fsRoot.endsWith("/") ? fsRoot : `${fsRoot}/`)) {
    // Mirror the host PDP deny (out-of-grant path) without leaking.
    throw { code: -32001, message: `Filesystem access denied: ${p} outside grant ${fsRoot}` } satisfies FsOpError;
  }
  try {
    switch (method) {
      case "ezcorp/fs.read": {
        const buf = readFileSync(p);
        return {
          encoding: params.encoding === "binary" ? "binary" : "utf-8",
          body: buf.toString("base64"),
          bytes: buf.byteLength,
          resolvedPath: p,
        };
      }
      case "ezcorp/fs.write": {
        // Mirror handleFsWriteRpc: missing/non-string content → -32602.
        if (typeof params.content !== "string") {
          throw { code: -32602, message: "Missing content (string)" } satisfies FsOpError;
        }
        const content = params.content;
        const buf = params.encoding === "binary"
          ? Buffer.from(content, "base64")
          : Buffer.from(content, "utf8");
        writeFileSync(p, buf);
        return { bytes: buf.byteLength, resolvedPath: p };
      }
      case "ezcorp/fs.list": {
        const dirents = readdirSync(p, { withFileTypes: true });
        return {
          entries: dirents.map((d) => ({
            name: d.name,
            isFile: d.isFile(),
            isDirectory: d.isDirectory(),
          })),
        };
      }
      case "ezcorp/fs.stat": {
        const st = statSync(p);
        return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory(), resolvedPath: p };
      }
      case "ezcorp/fs.exists":
        return { exists: existsSync(p) };
      case "ezcorp/fs.mkdir":
        mkdirSync(p, { recursive: params.recursive === true });
        return { resolvedPath: p };
      case "ezcorp/fs.unlink":
        rmSync(p, { force: false });
        return { resolvedPath: p };
      default:
        throw { code: -32601, message: `Unsupported fs method: ${method}` } satisfies FsOpError;
    }
  } catch (e) {
    if (isFsOpError(e)) throw e; // guard / unsupported-method (numeric code)
    // Node errno (string `.code`) → numeric -32000 with the host's ioErrorMsg shape.
    const errno = e as NodeJS.ErrnoException;
    throw { code: -32000, message: `${errno.code ?? "EIO"}: ${op} failed: ${errno.message}` } satisfies FsOpError;
  }
}

/**
 * Build the `ezcorp/fs.*` reverse-RPC handler (subprocess transport),
 * confined to `fsRoot`. Returns `undefined` for non-fs methods so a caller
 * can chain other handlers.
 */
export function makeFsRpcHandler(fsRoot: string) {
  return (req: JsonRpcRequest): JsonRpcResponse | undefined => {
    if (!req.method.startsWith("ezcorp/fs.")) return undefined;
    try {
      return ok(req.id, runFsOp(req.method, (req.params ?? {}) as Record<string, unknown>, fsRoot));
    } catch (e) {
      const err = e as FsOpError;
      return fail(req.id, err.code, err.message);
    }
  };
}

/**
 * Install a reverse-RPC request handler on an already-constructed
 * `ExtensionProcess` that answers `ezcorp/fs.*` against `fsRoot`. Pass
 * `onRequest` to answer additional host methods (e.g.
 * `ezcorp/network.internal`); it's checked first and may return `undefined`
 * to fall through to the fs handler.
 */
export function wireFsHandler(
  proc: RequestWirable,
  opts: {
    fsRoot?: string;
    onRequest?: (req: JsonRpcRequest) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
  } = {},
): void {
  const fsHandler = makeFsRpcHandler(opts.fsRoot ?? tmpdir());
  proc.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
    if (opts.onRequest) {
      const custom = await opts.onRequest(req);
      if (custom) return custom;
    }
    const res = fsHandler(req);
    if (res) return res;
    return fail(req.id, -32601, `Method not found: ${req.method}`);
  });
}

/**
 * IN-PROCESS variant: stub the SDK channel singleton's `request` so an
 * extension's host-mediated `fs*` helpers resolve against real disk under
 * `fsRoot`, WITHOUT spawning a subprocess. For unit/integration tests that
 * call the extension's vault/store functions directly.
 *
 * Sets `EZCORP_FS_ALLOWED=1` (satisfies the SDK pre-flight; the stub IS the
 * host). Must be RE-CALLED in `beforeEach`: the shared `src/__tests__/preload.ts`
 * runs `__resetChannelForTests()` after every test, dropping the singleton.
 * Non-fs methods throw so unrelated RPC usage stays loud.
 */
export function installFsChannelStub(fsRoot: string): void {
  process.env.EZCORP_FS_ALLOWED = "1";
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (method: string, params: unknown): Promise<unknown> => {
    if (!method.startsWith("ezcorp/fs.")) {
      throw new Error(`fs channel stub: unexpected RPC method ${method}`);
    }
    try {
      return runFsOp(method, (params ?? {}) as Record<string, unknown>, fsRoot);
    } catch (e) {
      const err = e as FsOpError;
      throw new JsonRpcError(err.code, err.message);
    }
  }) as ReturnType<typeof getChannel>["request"]);
}
