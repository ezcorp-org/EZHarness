// File-backed TTL + LRU cache. Keyed by sha256 → string value. Backed by a
// single JSON file under `.ezcorp/extension-data/web-search/cache.json`.
//
// Design notes:
//   - In-memory Map is the source of truth; the file is a durable mirror.
//   - LRU is implemented via `Map` insertion-order (delete + set on access).
//   - The file write is best-effort: a failed flush is logged via `onError`
//     but never throws, because cache writes MUST NOT break a tool call.

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, Entry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.value === "string" && typeof v.expiresAt === "number") {
          this.map.set(k, v);
        }
      }
    } catch (err) {
      // Missing file or corrupt JSON → start empty. Never propagate.
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
      await mkdir(dirname(this.filePath), { recursive: true });
      const obj: Record<string, Entry> = {};
      for (const [k, v] of this.map) obj[k] = v;
      await writeFile(this.filePath, JSON.stringify(obj));
    } catch (err) {
      this.onError(err, "write");
    }
  }
}
