import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { listFirstPartyExtensionSources, snapshotFirstPartyExtension } from "./migrate-extension-v4";

export interface SourceLock { schemaVersion: 4; sources: Record<string, unknown> }

export function diffLockfiles(before: { sources?: Record<string, unknown>; extensions?: Record<string, unknown> } | null, after: { sources?: Record<string, unknown>; extensions?: Record<string, unknown> }): { added: string[]; removed: string[]; changed: string[] } {
  const previous = before?.sources ?? before?.extensions ?? {};
  const next = after.sources ?? after.extensions ?? {};
  return {
    added: Object.keys(next).filter((key) => !(key in previous)).sort(),
    removed: Object.keys(previous).filter((key) => !(key in next)).sort(),
    changed: Object.keys(next).filter((key) => key in previous && canonicalJson(previous[key]) !== canonicalJson(next[key])).sort(),
  };
}

export function computeCheckDecision(diff: ReturnType<typeof diffLockfiles>): { exitCode: number; message: string } {
  const lines = [...diff.added.map((name) => `+ ${name}`), ...diff.removed.map((name) => `- ${name}`), ...diff.changed.map((name) => `~ ${name}`)];
  return lines.length ? { exitCode: 1, message: `${lines.join("\n")}\nmanifest.lock.json is out of date. Run \`bun run scripts/regenerate-manifest-lock.ts\`.` } : { exitCode: 0, message: "Lockfile is up to date." };
}

export async function generateSourceLock(projectRoot: string): Promise<SourceLock> {
  const sources: Record<string, unknown> = Object.create(null);
  for (const source of await listFirstPartyExtensionSources(projectRoot)) {
    const snapshot = await snapshotFirstPartyExtension(projectRoot, source.name);
    sources[source.name] = {
      directory: source.directory,
      entrypoint: source.entrypoint,
      files: Object.keys(snapshot.files).length,
      bytes: snapshot.bytes,
      sourceDigest: createHash("sha256").update(canonicalJson(snapshot.files)).digest("hex"),
    };
  }
  return { schemaVersion: 4, sources };
}

export async function buildLockfile(projectRoot: string): Promise<{ lockfile: SourceLock; errors: string[] }> {
  return { lockfile: await generateSourceLock(projectRoot), errors: [] };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => !["--check", "--dry-run"].includes(arg));
  if (unknown) { console.error(`unknown flag: ${unknown}`); process.exit(2); }
  if (args.length > 1) { console.error("--check and --dry-run are mutually exclusive"); process.exit(2); }
  const root = resolve(dirname(import.meta.path), "..");
  const path = resolve(root, "manifest.lock.json");
  const expected = `${JSON.stringify(await generateSourceLock(root), null, 2)}\n`;
  const actual = await Bun.file(path).text().catch(() => "");
  if (args.includes("--check")) {
    if (actual !== expected) { console.error("First-party source lock changed. Run bun scripts/regenerate-manifest-lock.ts and review the source changes."); process.exitCode = 1; }
  } else if (args.includes("--dry-run")) {
    console.log(actual === expected ? "Source lock is current" : "Source lock requires an update");
  } else {
    await Bun.write(path, expected);
    console.log("Updated data-only first-party source lock; no configs executed");
  }
}
