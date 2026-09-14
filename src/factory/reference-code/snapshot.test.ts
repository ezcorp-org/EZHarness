import { describe, expect, test } from "bun:test";
import { referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST, REFERENCE_CODE_LAUNCH_FILES } from "./fixtures";
import {
  referenceCodeBaseBlobs,
  referenceCodeFilesDigest,
  referenceCodeScripts,
  sealReferenceCodeSnapshot,
  snapshotReferenceCodeRepository,
  ReferenceCodeSnapshotError,
  REFERENCE_CODE_LOCK_NAMES,
  REFERENCE_CODE_REQUIRED_SCRIPTS,
  REFERENCE_CODE_SNAPSHOT_LIMITS,
  type ReferenceCodeRepositoryReader,
  type ReferenceCodeTreeEntry,
} from "./snapshot";

const encoder = new TextEncoder();
const BASE = "a".repeat(39) + "1";
const TREE = "b".repeat(39) + "2";

function entries(overrides: readonly ReferenceCodeTreeEntry[] = [], drop: readonly string[] = []): ReferenceCodeTreeEntry[] {
  const base = referenceCodeLaunchRepository()
    .filter(file => !drop.includes(file.path))
    .map(file => ({ path: file.path, mode: file.mode as string, content: file.content }));
  return [...base.filter(entry => !overrides.some(override => override.path === entry.path)), ...overrides];
}

function reader(listing: readonly ReferenceCodeTreeEntry[], commitSha = BASE): ReferenceCodeRepositoryReader {
  return {
    resolveCommit: async () => ({ commitSha, treeSha: TREE }),
    readTree: async () => listing,
  };
}

describe("sealing a pinned snapshot", () => {
  test("seals the launch repository with its lockfile, scripts, and a content digest", () => {
    const snapshot = sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries() });
    expect(snapshot.baseSha).toBe(BASE);
    expect(snapshot.treeSha).toBe(TREE);
    expect(snapshot.dependencyLockPath).toBe("bun.lock");
    expect(snapshot.dependencyLockDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.scripts).toEqual({ build: "bun build src/slugify.ts --outdir dist --target bun", typecheck: "tsc --noEmit", test: "bun test" });
    expect(snapshot.digest).toBe(referenceCodeFilesDigest(referenceCodeLaunchRepository()));
    expect(snapshot.files.map(file => file.path)).toEqual([...snapshot.files].map(file => file.path).sort());
  });

  test("the content digest changes when one byte changes and is independent of listing order", () => {
    const files = referenceCodeLaunchRepository();
    const reversed = [...files].reverse();
    expect(referenceCodeFilesDigest(reversed)).toBe(referenceCodeFilesDigest(files));
    const edited = files.map(file => (file.path === "src/slugify.ts" ? { ...file, content: encoder.encode("export const x = 1;\n") } : file));
    expect(referenceCodeFilesDigest(edited)).not.toBe(referenceCodeFilesDigest(files));
  });

  test("refuses a symlink by name", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([{ path: "src/link.ts", mode: "120000", content: encoder.encode("../../etc/passwd") }]) }))
      .toThrow(/reference_code_tree_unsupported: symlink at src\/link\.ts/);
  });

  test("refuses a submodule by name", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([{ path: "vendor", mode: "160000", content: new Uint8Array() }]) }))
      .toThrow(/reference_code_tree_unsupported: submodule at vendor/);
  });

  test("refuses any other git mode", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([{ path: "src/odd.ts", mode: "40000", content: new Uint8Array() }]) }))
      .toThrow(/reference_code_tree_unsupported: mode 40000/);
  });

  test("refuses an escaping path and a duplicate path", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([{ path: "../escape.ts", mode: "100644", content: new Uint8Array() }]) }))
      .toThrow(/reference_code_tree_unsupported: path \.\.\/escape\.ts/);
    const duplicate = entries();
    duplicate.push({ path: "src/slugify.ts", mode: "100644", content: encoder.encode("x") });
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: duplicate }))
      .toThrow(/duplicate path src\/slugify\.ts/);
  });

  test("refuses a tree with no manifest and a tree with no lockfile", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([], ["package.json"]) }))
      .toThrow(/reference_code_manifest_missing/);
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries([], ["bun.lock"]) }))
      .toThrow(new RegExp(`reference_code_lockfile_missing: ${REFERENCE_CODE_LOCK_NAMES.join(" or ")}`));
  });

  test("refuses an empty tree, too many entries, an oversized file, and an oversized tree", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: [] })).toThrow(/reference_code_snapshot_too_large: 0 entries/);
    const many = Array.from({ length: REFERENCE_CODE_SNAPSHOT_LIMITS.maxFiles + 1 }, (_, index) => ({ path: `src/f${index}.ts`, mode: "100644", content: new Uint8Array() }));
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: many })).toThrow(/reference_code_snapshot_too_large: 5001 entries/);
    const huge = entries([{ path: "src/big.bin", mode: "100644", content: new Uint8Array(REFERENCE_CODE_SNAPSHOT_LIMITS.maxFileBytes + 1) }]);
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: huge })).toThrow(/reference_code_snapshot_too_large: src\/big\.bin/);
    const wide = Array.from({ length: 5 }, (_, index) => ({ path: `src/f${index}.bin`, mode: "100644", content: new Uint8Array(REFERENCE_CODE_SNAPSHOT_LIMITS.maxFileBytes) }));
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: [...entries(), ...wide] })).toThrow(/reference_code_snapshot_too_large: \d+ bytes/);
  });

  test("refuses a base or tree id that is not a full object id", () => {
    expect(() => sealReferenceCodeSnapshot({ baseSha: "abc", treeSha: TREE, entries: entries() })).toThrow();
    expect(() => sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: "abc", entries: entries() })).toThrow();
  });

  test("exposes the base blob ids a candidate is compared against", () => {
    const snapshot = sealReferenceCodeSnapshot({ baseSha: BASE, treeSha: TREE, entries: entries() });
    const blobs = referenceCodeBaseBlobs(snapshot);
    expect(blobs.size).toBe(snapshot.files.length);
    expect(blobs.get("src/slugify.ts")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the supported launch repository's declared scripts", () => {
  test("reads exactly the three C10 scripts", () => {
    expect([...REFERENCE_CODE_REQUIRED_SCRIPTS]).toEqual(["build", "typecheck", "test"]);
    expect(referenceCodeScripts(encoder.encode(REFERENCE_CODE_LAUNCH_FILES["package.json"]!)).test).toBe("bun test");
  });

  test("refuses a manifest that is not JSON, not an object, or not UTF-8", () => {
    expect(() => referenceCodeScripts(encoder.encode("{"))).toThrow(/reference_code_manifest_invalid/);
    expect(() => referenceCodeScripts(encoder.encode("[]"))).toThrow(/reference_code_manifest_invalid: package.json is not an object/);
    expect(() => referenceCodeScripts(encoder.encode("null"))).toThrow(/reference_code_manifest_invalid: package.json is not an object/);
    expect(() => referenceCodeScripts(new Uint8Array([0xff, 0xfe]))).toThrow(/reference_code_manifest_invalid: not valid UTF-8/);
  });

  test("refuses a manifest with no scripts block and one with a missing or blank script", () => {
    expect(() => referenceCodeScripts(encoder.encode('{"name":"x"}'))).toThrow(/reference_code_script_missing: package.json declares no scripts/);
    expect(() => referenceCodeScripts(encoder.encode('{"scripts":[]}'))).toThrow(/reference_code_script_missing: package.json declares no scripts/);
    expect(() => referenceCodeScripts(encoder.encode('{"scripts":{"build":"x","typecheck":"y"}}'))).toThrow(/reference_code_script_missing: test/);
    expect(() => referenceCodeScripts(encoder.encode('{"scripts":{"build":"x","typecheck":"y","test":"   "}}'))).toThrow(/reference_code_script_missing: test/);
  });
});

describe("taking a snapshot through a reader", () => {
  test("snapshots the pinned commit the caller named", async () => {
    const snapshot = await snapshotReferenceCodeRepository(reader(entries()), BASE);
    expect(snapshot.baseSha).toBe(BASE);
    expect(snapshot.files).toHaveLength(referenceCodeLaunchRepository().length);
    expect(REFERENCE_CODE_FIXTURE_REQUEST.dependencyLockPath).toBe(snapshot.dependencyLockPath);
  });

  test("refuses a reader that answers a different commit than the one pinned", async () => {
    await expect(snapshotReferenceCodeRepository(reader(entries(), "c".repeat(40)), BASE))
      .rejects.toThrow(/reference_code_base_commit_unknown: reader answered c{40}/);
  });

  test("refuses a base that is not a full object id before reading anything", async () => {
    let read = 0;
    const counting: ReferenceCodeRepositoryReader = {
      resolveCommit: async () => { read += 1; return { commitSha: BASE, treeSha: TREE }; },
      readTree: async () => { read += 1; return entries(); },
    };
    await expect(snapshotReferenceCodeRepository(counting, "main")).rejects.toThrow();
    expect(read).toBe(0);
  });

  test("carries the snapshot error class so a caller can classify it", () => {
    const error = new ReferenceCodeSnapshotError("reference_code_manifest_missing");
    expect(error.name).toBe("ReferenceCodeSnapshotError");
    expect(error.code).toBe("reference_code_manifest_missing");
    expect(error.message).toBe("reference_code_manifest_missing");
  });
});
