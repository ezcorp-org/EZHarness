#!/usr/bin/env bun
// ── sanity-check.ts — LIVE field-name / shape verification ──────────
//
// The source parsers deliberately never crash on shape drift (they
// degrade to null). That safety means a silent PSA/PriceCharting field
// rename would go unnoticed by `bun test` (which is fixture-only, no
// network). This script is the deliberate LIVE check:
//
//   bun docs/extensions/examples/graded-card-scanner/scripts/sanity-check.ts \
//       <cert> [certs…] [--fixtures]
//
// For each cert it runs the REAL pipeline and asserts:
//   - identity fields are present (subject/year/set/grade non-empty) —
//     a rename would blank one and fail here,
//   - every population is an integer or null (never a float/guess),
//   - every price is money (finite, ≥ 0) or null,
//   - a second lookup is served from cache (the source fetch-count did
//     not grow).
// Any failure → non-zero exit.
//
// `--fixtures` runs the identical checks against the offline fixtures
// (deterministic, no network) — that path is what the unit test drives.
// Live mode shares every line except how the deps are built; requests
// are rate-limited by the same per-host queue the extension uses.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLookup, type PipelineDeps, type PipelineStorage } from "../lib/pipeline";
import { createHostQueue, createQueuedFetch, createRobots, type FetchImpl, type Robots } from "../lib/politeness";
import { fetchPsaCert } from "../lib/sources/psa-api";
import { fetchPrices } from "../lib/sources/pricecharting";
import { resolveToken } from "../lib/token";
import type { CardRecord } from "../app/lib/format.js";

// ── Per-cert checks ─────────────────────────────────────────────────

export interface CertCheck {
  cert: string;
  identityOk: boolean;
  popOk: boolean;
  pricesOk: boolean;
  cacheOk: boolean;
  pass: boolean;
}

export interface SanityReport {
  results: CertCheck[];
  ok: boolean;
}

function identityPresent(record: CardRecord): boolean {
  const id = record.identity;
  return id.subject !== "" && id.year !== "" && id.set !== "" && id.grade !== "";
}

function popsSane(record: CardRecord): boolean {
  return record.grades.every((g) => g.pop === null || Number.isInteger(g.pop));
}

function pricesSane(record: CardRecord): boolean {
  return record.grades.every(
    (g) => g.price === null || (Number.isFinite(g.price) && (g.price as number) >= 0),
  );
}

/**
 * Run the sanity checks over `certs` using the given pipeline deps. The
 * source fetches are wrapped in a counter so the cache assertion can
 * observe whether the second lookup hit the network.
 */
export async function runSanity(certs: string[], deps: PipelineDeps): Promise<SanityReport> {
  let fetches = 0;
  const counted: PipelineDeps = {
    ...deps,
    fetchPsa: (cert, token) => { fetches++; return deps.fetchPsa(cert, token); },
    fetchPrices: (identity) => { fetches++; return deps.fetchPrices(identity); },
  };
  const lookup = buildLookup(counted);

  const results: CertCheck[] = [];
  for (const cert of certs) {
    const record = await lookup(cert, true); // fresh → must fetch
    const afterFirst = fetches;
    await lookup(cert, false); // should be served from cache
    const cacheOk = fetches === afterFirst;

    const identityOk = identityPresent(record);
    const popOk = popsSane(record);
    const pricesOk = pricesSane(record);
    results.push({
      cert,
      identityOk,
      popOk,
      pricesOk,
      cacheOk,
      pass: identityOk && popOk && pricesOk && cacheOk,
    });
  }
  return { results, ok: results.every((r) => r.pass) };
}

/** Render a plain pass/fail table for the console. */
export function formatReport(report: SanityReport): string {
  const yn = (b: boolean) => (b ? "ok" : "FAIL");
  const lines = ["cert        identity  pop   price  cache  result"];
  for (const r of report.results) {
    lines.push(
      `${r.cert.padEnd(11)} ${yn(r.identityOk).padEnd(8)} ${yn(r.popOk).padEnd(5)} ${yn(r.pricesOk).padEnd(6)} ${yn(r.cacheOk).padEnd(6)} ${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  lines.push(report.ok ? "\nAll checks passed." : "\nSome checks FAILED — a source shape may have drifted.");
  return lines.join("\n");
}

// ── Storage + deps builders ─────────────────────────────────────────

/** Ephemeral in-memory Storage — the sanity run never touches real
 *  extension state. */
export function memoryStorage(): PipelineStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return data.has(key)
        ? { value: data.get(key) as T, exists: true }
        : { value: null, exists: false };
    },
    async set<T = unknown>(key: string, value: T) {
      data.set(key, value);
      return { ok: true };
    },
  };
}

const FIXTURE_DIR = join(import.meta.dir, "..", "__fixtures__");

/** Offline deps that drive the REAL parsers against the fixtures. */
export function fixturesDeps(): PipelineDeps {
  const psaJson = readFileSync(join(FIXTURE_DIR, "psa-cert-response.json"), "utf8");
  const searchHtml = readFileSync(join(FIXTURE_DIR, "pricecharting-search.html"), "utf8");
  const productHtml = readFileSync(join(FIXTURE_DIR, "pricecharting-product.html"), "utf8");
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes("api.psacard.com")) return new Response(psaJson, { status: 200 }) as Response;
    if (url.includes("/search-products")) return new Response(searchHtml, { status: 200 }) as Response;
    return new Response(productHtml, { status: 200 }) as Response;
  };
  const robots: Robots = { isAllowed: async () => true };
  return {
    getToken: async () => "fixtures-token",
    fetchPsa: (cert, token) => fetchPsaCert(cert, token, fetchImpl),
    fetchPrices: (identity) => fetchPrices(identity, fetchImpl, robots),
    storage: memoryStorage(),
    now: () => new Date().toISOString(),
  };
}

/** Live deps: real network via the shared per-host queue; token from env
 *  only (the CLI has no Storage channel). Construction hits no network. */
export function liveDeps(env: Record<string, string | undefined>): PipelineDeps {
  const queuedFetch = createQueuedFetch(createHostQueue(), fetch);
  const robots = createRobots(queuedFetch);
  const tokenStorage = { get: async () => ({ value: null, exists: false }) };
  return {
    getToken: () => resolveToken(env, tokenStorage),
    fetchPsa: (cert, token) => fetchPsaCert(cert, token, queuedFetch),
    fetchPrices: (identity) => fetchPrices(identity, queuedFetch, robots),
    storage: memoryStorage(),
    now: () => new Date().toISOString(),
  };
}

export function defaultMakeDeps(fixtures: boolean): PipelineDeps {
  return fixtures ? fixturesDeps() : liveDeps(process.env);
}

// ── CLI entry ───────────────────────────────────────────────────────

export interface ParsedArgs {
  fixtures: boolean;
  certs: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const fixtures = argv.includes("--fixtures");
  const certs = argv.filter((a) => !a.startsWith("--"));
  return { fixtures, certs };
}

/**
 * Entry point. Returns the process exit code (0 pass, 1 fail, 2 usage).
 * `makeDeps` is injectable so the test drives the fixtures path offline.
 */
export async function main(
  argv: string[],
  log: (msg: string) => void = console.log,
  makeDeps: (fixtures: boolean) => PipelineDeps = defaultMakeDeps,
): Promise<number> {
  const { fixtures, certs } = parseArgs(argv);
  if (certs.length === 0) {
    log("usage: sanity-check <cert> [certs…] [--fixtures]");
    return 2;
  }
  const report = await runSanity(certs, makeDeps(fixtures));
  log(formatReport(report));
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
