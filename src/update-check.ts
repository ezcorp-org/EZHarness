import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "./db/connection";
import { logger } from "./logger";

const log = logger.child("update-check");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  source: "github-releases" | "disabled";
  releaseUrl?: string;
}

interface CachedCheck {
  latest: string | null;
  releaseUrl?: string;
  checkedAt: string; // ISO
}

function cachePath(): string {
  const dbPath = getDbPath();
  const base = dbPath === "external" || dbPath === ":memory:"
    ? `${process.env.HOME}/ez-corp/.data`
    : dirname(dbPath);
  return `${base}/.update-check.json`;
}

function readCache(): CachedCheck | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.checkedAt === "string") return parsed as CachedCheck;
    return null;
  } catch {
    return null;
  }
}

function writeCache(c: CachedCheck): void {
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(c, null, 2));
  } catch (err) {
    log.warn("Could not persist update-check cache", { error: String(err) });
  }
}

/**
 * Compare two semver-ish strings. Extracts the first `N.N.N`-like substring
 * from each input so any prefix (`v`, `app-v`, `bun-v`, `@pkg/name@`, etc.)
 * and any suffix (`-rc.1`, `-beta`, `+build`) are ignored. Returns positive
 * if a > b, negative if a < b, 0 if equal or neither contains a version.
 */
export function compareVersions(a: string, b: string): number {
  const extract = (s: string): number[] => {
    const m = s.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return [];
    return [m[1], m[2], m[3]].map((p) => (p === undefined ? 0 : parseInt(p, 10)));
  };
  const [aParts, bParts] = [extract(a), extract(b)];
  if (aParts.length === 0 && bParts.length === 0) return 0;
  if (aParts.length === 0) return -1;
  if (bParts.length === 0) return 1;
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function currentVersion(): string {
  return process.env.EZCORP_IMAGE_VERSION || "dev";
}

async function fetchLatestRelease(repo: string): Promise<{ tag: string; url: string } | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ezcorp-update-check" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn("GitHub release fetch non-ok", { status: res.status });
      return null;
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!data.tag_name) return null;
    return { tag: data.tag_name, url: data.html_url ?? `https://github.com/${repo}/releases` };
  } catch (err) {
    log.warn("GitHub release fetch failed", { error: String(err) });
    return null;
  }
}

export async function getUpdateCheck(): Promise<UpdateCheckResult> {
  const current = currentVersion();
  const enabled = (process.env.EZCORP_CHECK_UPDATES ?? "true") !== "false";
  const repo = process.env.EZCORP_UPDATE_REPO;

  if (!enabled || !repo) {
    return { current, latest: null, updateAvailable: false, checkedAt: null, source: "disabled" };
  }

  const cached = readCache();
  const cacheAge = cached ? Date.now() - new Date(cached.checkedAt).getTime() : Infinity;

  if (cached && cacheAge < CACHE_TTL_MS) {
    return {
      current,
      latest: cached.latest,
      updateAvailable: cached.latest ? compareVersions(cached.latest, current) > 0 : false,
      checkedAt: cached.checkedAt,
      source: "github-releases",
      releaseUrl: cached.releaseUrl,
    };
  }

  const fresh = await fetchLatestRelease(repo);
  const checkedAt = new Date().toISOString();
  const latest = fresh?.tag ?? cached?.latest ?? null;
  const releaseUrl = fresh?.url ?? cached?.releaseUrl;

  writeCache({ latest, releaseUrl, checkedAt });

  return {
    current,
    latest,
    updateAvailable: latest ? compareVersions(latest, current) > 0 : false,
    checkedAt,
    source: "github-releases",
    releaseUrl,
  };
}
