/**
 * In-memory registry over filesystem and DB command sources.
 *
 * Dependency-injected (via `createCommandRegistry`) so tests can supply a
 * stub `dbLister` and fixed `homePath`/`scanHome`. Production callers pass
 * the real DB query and environment values.
 *
 * Cache: keyed on `(userId, projectId)` with a TTL (default 2 s). Each
 * listing scans the project filesystem, optionally the user's home, and
 * queries the DB once. Writers (DB command mutations) should call
 * `invalidate()` to drop the cached entry.
 *
 * Collision policy: commands from different sources are all returned —
 * `listCommands` preserves them with their `source` namespace so the UI
 * can disambiguate. `findCommand(name)` returns the first match in
 * project→home→db precedence order.
 */

import type { CommandRecord, CommandSource } from "./discovery";
import {
  discoverProjectCommands,
  discoverHomeCommands,
} from "./discovery";

export interface DbCommandRecord {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, string>;
}

export interface ListOpts {
  userId: string;
  projectId: string;
  /** Absolute path to the active project, or null for global context. */
  projectPath: string | null;
}

export interface FindOpts extends ListOpts {
  name: string;
}

export interface CommandRegistry {
  listCommands(opts: ListOpts): Promise<CommandRecord[]>;
  findCommand(opts: FindOpts): Promise<CommandRecord | null>;
  invalidate(opts: { userId: string; projectId: string }): void;
}

export interface RegistryConfig {
  /** Absolute path to the user's home directory (gated by `scanHome`). */
  homePath: string;
  /** When false, never scan home-dir roots — used for multi-tenant deploys. */
  scanHome: boolean;
  /** Pulls the userCommands DB rows for this user. */
  dbLister: (userId: string) => Promise<DbCommandRecord[]>;
  /** TTL for cached entries. Defaults to 2 s. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  at: number;
  commands: CommandRecord[];
}

function dbToRecord(row: DbCommandRecord): CommandRecord {
  return {
    name: row.name,
    namespace: "user:db",
    description: row.description,
    body: row.body,
    frontmatter: row.frontmatter,
    source: "user:db",
    path: "",
  };
}

// Precedence for `findCommand`: later sources are lower priority so the
// project-local command wins over a same-named home / DB entry.
const PRECEDENCE: CommandSource[] = [
  "project:claude-commands",
  "project:claude-agents",
  "project:codex-prompts",
  "project:agents",
  "user:claude-commands",
  "user:claude-agents",
  "user:codex-prompts",
  "user:agents",
];

export function createCommandRegistry(cfg: RegistryConfig): CommandRegistry {
  const ttl = cfg.cacheTtlMs ?? 2_000;
  const cache = new Map<string, CacheEntry>();
  const cacheKey = (userId: string, projectId: string) =>
    `${userId}::${projectId}`;

  async function load(opts: ListOpts): Promise<CommandRecord[]> {
    const results: CommandRecord[] = [];

    if (opts.projectPath) {
      results.push(...(await discoverProjectCommands(opts.projectPath)));
    }

    if (cfg.scanHome) {
      results.push(...(await discoverHomeCommands(cfg.homePath)));
    }

    const dbRows = await cfg.dbLister(opts.userId);
    for (const row of dbRows) results.push(dbToRecord(row));

    return results;
  }

  async function listCommands(opts: ListOpts): Promise<CommandRecord[]> {
    const key = cacheKey(opts.userId, opts.projectId);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttl) return hit.commands;

    const commands = await load(opts);
    cache.set(key, { at: now, commands });
    return commands;
  }

  async function findCommand(opts: FindOpts): Promise<CommandRecord | null> {
    const all = await listCommands(opts);
    const matches = all.filter((c) => c.name === opts.name);
    if (matches.length === 0) return null;
    // Sort by PRECEDENCE order; unknown sources sort to the end.
    matches.sort((a, b) => {
      const ai = PRECEDENCE.indexOf(a.source);
      const bi = PRECEDENCE.indexOf(b.source);
      const aRank = ai === -1 ? PRECEDENCE.length : ai;
      const bRank = bi === -1 ? PRECEDENCE.length : bi;
      return aRank - bRank;
    });
    return matches[0]!;
  }

  function invalidate(opts: { userId: string; projectId: string }): void {
    cache.delete(cacheKey(opts.userId, opts.projectId));
  }

  return { listCommands, findCommand, invalidate };
}
