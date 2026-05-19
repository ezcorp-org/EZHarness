// File-backed TTL + LRU cache. Keyed by sha256 → string value. Backed by a
// single JSON file under `.ezcorp/extension-data/web-search/cache.json`.
//
// Design notes:
//   - In-memory Map is the source of truth; the file is a durable mirror.
//   - LRU is implemented via `Map` insertion-order (delete + set on access).
//   - The file write is best-effort: a failed flush is logged via `onError`
//     but never throws, because cache writes MUST NOT break a tool call.
//   - IO routes through `@ezcorp/sdk/runtime` fs helpers (Phase 3
//     host-mediated reverse-RPC). Raw `node:fs/promises` is poisoned by
//     the sandbox-preload, so a top-level import would crash the
//     subprocess at boot.

import { fsMkdir, fsRead, fsWrite, JsonRpcError } from "@ezcorp/sdk/runtime";
import { dirname } from "node:path";

interface Entry {
  value: string;
  expiresAt: number;
}

export interface DiskCacheOptions {
  filePath: string;
  /** Maximum entries retained; oldest are evicted first. */
  maxEntries: number;
  now?: () => number;
  onError?: (err: unknown, op: "read" | "write") => void;
}

export class DiskCache {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown, op: "read" | "write") => void;
  private readonly map = new Map<string, Entry>();
  private loaded = false;

  constructor(opts: DiskCacheOptions) {
    this.filePath = opts.filePath;
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = (await fsRead(this.filePath)) as string;
      const parsed = JSON.parse(raw) as Record<string, Entry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.value === "string" && typeof v.expiresAt === "number") {
          this.map.set(k, v);
        }
      }
    } catch (err) {
      // Missing file or corrupt JSON → start empty. Never propagate.
      // No-filesystem-grant (`EZCORP_FS_ALLOWED` unset) surfaces here as
      // a regular Error from the SDK pre-flight — also swallowed; the
      // cache silently degrades to an in-memory map for one run.
      this.onError(err, "read");
    }
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureLoaded();
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ensureLoaded();
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    try {
      await fsMkdir(dirname(this.filePath), { recursive: true });
      const obj: Record<string, Entry> = {};
      for (const [k, v] of this.map) obj[k] = v;
      await fsWrite(this.filePath, JSON.stringify(obj));
    } catch (err) {
      // Host-side JsonRpcError (no grant, EROFS, etc.) and any
      // unexpected throw both flow here; never propagate so a cache
      // write failure can't break a tool call. `onError` lets the
      // host log via the extension's stderr.
      if (err instanceof JsonRpcError) {
        this.onError(err, "write");
      } else {
        this.onError(err, "write");
      }
    }
  }
}
