import { describe, expect, test } from "bun:test";
import { posix, resolve } from "node:path";
import { withoutGitContext } from "@ezcorp/sdk/git";
import { listFirstPartyExtensionSources, snapshotExtensionSource } from "../../scripts/migrate-extension-v4";

// A first-party release seals its source snapshot, and the isolated build runs every sealed test file as a feature
// test in its own container (packages/@ezcorp/extension-runner/src/podman.ts runFeatureTests). The snapshot leaves out
// a test whose first bytes are the host-integration marker. So a sealed test must never name a file the snapshot
// leaves out: in the build it finds nothing, fails, and the release ends build_failed.
// W4H-33b: ai-kit's test/unit/deployed-preconditions.test.ts ran `bun test ./test/e2e/${suite}.test.ts` as a child;
// the build printed 'Test filter "./test/e2e/bundled.test.ts" had no matches', and six hosted lanes went red.

const ROOT = resolve(import.meta.dir, "../..");
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RELATIVE_LITERAL = /(["'`])(\.{1,2}\/[^"'`\s]+)\1/g;
const SUFFIXES = ["", ".ts", ".js", "/index.ts"];

/** A relative path literal as a whole-path pattern; a template `${…}` part stands for one path segment. */
function literalPattern(literal: string): RegExp {
  const parts = literal.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`);
}

/** The sealed tests of one snapshot that name a file of the source the snapshot leaves out, and nothing it keeps. */
function sealedReferencesToExcluded(sealed: ReadonlyMap<string, string>, excluded: readonly string[]): string[] {
  const kept = [...sealed.keys()];
  const findings: string[] = [];
  for (const [path, source] of sealed) {
    if (!TEST_FILE.test(path)) continue;
    for (const [, , literal] of source.matchAll(RELATIVE_LITERAL)) {
      const bases = new Set(["", posix.dirname(path)]);
      const candidates = [...bases].flatMap((base) => SUFFIXES.map((suffix) => posix.normalize(posix.join(base, literal + suffix))));
      const patterns = candidates.filter((candidate) => !candidate.startsWith("../")).map(literalPattern);
      const names = (files: readonly string[]) => files.some((file) => patterns.some((pattern) => pattern.test(file)));
      if (names(excluded) && !names(kept)) findings.push(`${path}: names ${literal}, which the release snapshot leaves out`);
    }
  }
  return findings;
}

function trackedFiles(directory: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", directory], { cwd: ROOT, env: withoutGitContext(process.env) });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\0").filter(Boolean).map((file) => file.slice(directory.length + 1));
}

describe("sealed first-party tests name only files the release keeps", () => {
  test("a sealed test naming a left-out suite (also by a template) is a finding; a kept target is not", () => {
    const sealed = new Map([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text of a sealed test, not a JS template string
      ["test/unit/drives.test.ts", "Bun.spawn([bun, 'test', `./test/e2e/${suite}.test.ts`])"],
      ["test/unit/helper.test.ts", "import { poll } from '../e2e/_poll'; const data = './fixtures/data.json';"],
      ["test/e2e/_poll.ts", "export const poll = 1;"],
    ]);
    expect(sealedReferencesToExcluded(sealed, ["test/e2e/bundled.test.ts", "fixtures/data.json"])).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the finding quotes the sealed test's literal source text
      "test/unit/drives.test.ts: names ./test/e2e/${suite}.test.ts, which the release snapshot leaves out",
      "test/unit/helper.test.ts: names ./fixtures/data.json, which the release snapshot leaves out",
    ]);
    expect(sealedReferencesToExcluded(sealed, [])).toEqual([]);
  });

  test("every first-party release snapshot in the tree", async () => {
    const findings: string[] = [];
    for (const source of await listFirstPartyExtensionSources(ROOT)) {
      const snapshot = await snapshotExtensionSource(ROOT, source);
      // Only test files are read; every kept path still counts as a target.
      const sealed = new Map<string, string>();
      for (const path of Object.keys(snapshot.files)) sealed.set(path, TEST_FILE.test(path) ? await Bun.file(resolve(ROOT, source.directory, path)).text() : "");
      const excluded = trackedFiles(source.directory).filter((file) => !(file in snapshot.files));
      findings.push(...sealedReferencesToExcluded(sealed, excluded).map((finding) => `${source.directory}/${finding}`));
    }
    expect(findings).toEqual([]);
  }, 120_000);
});
