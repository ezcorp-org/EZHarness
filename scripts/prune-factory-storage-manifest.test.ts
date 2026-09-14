import { expect, test } from "bun:test";
import {
  FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION,
  FACTORY_STORAGE_PRUNE_MAX_OBJECTS,
  FactoryStoragePruneError,
  assertFactoryStoragePruneManifest,
} from "./prune-factory-storage-manifest.ts";

/**
 * The manifest is the whole blast radius of a destructive tool on a shared store.
 *
 * Every case here is about one property: an entry may name exactly one object version and nothing
 * broader. A shape that could stand for objects the run never wrote is what turns a cleanup into a
 * bulk deletion, and that is the mistake this file exists to make impossible to repeat.
 */
const entry = { bucket: "tenant-01", key: "ordinary/archive-writer/run/abc", versionId: "v1" };
const manifest = { schemaVersion: FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION, store: "ordinary" as const, objects: [entry] };

test("an exact manifest is accepted and frozen", () => {
  const parsed = assertFactoryStoragePruneManifest(manifest);
  expect(parsed).toEqual(manifest);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.objects)).toBe(true);
  expect(Object.isFrozen(parsed.objects[0])).toBe(true);
  expect(assertFactoryStoragePruneManifest({ ...manifest, store: "archive" }).store).toBe("archive");
});

test("a key that could stand for more than one object is refused", () => {
  for (const key of [
    "ordinary/*",
    "ordinary/run/?",
    "ordinary/run/",
    "/ordinary/run/abc",
    "ordinary//run/abc",
    "ordinary/../escape",
    "ordinary/./abc",
    "",
    "x".repeat(1025),
  ]) {
    let error: unknown = null;
    try { assertFactoryStoragePruneManifest({ ...manifest, objects: [{ ...entry, key }] }); } catch (cause) { error = cause; }
    expect([key.slice(0, 20), (error as FactoryStoragePruneError)?.code]).toEqual([key.slice(0, 20), "factory_prune_manifest_invalid"]);
  }
});

test("an entry without an exact version is refused, because the current version is a guess", () => {
  for (const objects of [
    [{ bucket: entry.bucket, key: entry.key }],
    [{ ...entry, versionId: "" }],
    [{ ...entry, versionId: 1 }],
    [{ ...entry, versionId: null }],
  ]) {
    expect(() => assertFactoryStoragePruneManifest({ ...manifest, objects })).toThrow(FactoryStoragePruneError);
  }
});

test("every other malformed shape is refused with the same code", () => {
  const rejected: readonly unknown[] = [
    null, [], "manifest", 7,
    { ...manifest, schemaVersion: "factory.storage-prune-manifest.v0" },
    { ...manifest, store: "product" },
    { ...manifest, extra: true },
    { schemaVersion: manifest.schemaVersion, store: "ordinary" },
    { ...manifest, objects: [] },
    { ...manifest, objects: "all" },
    { ...manifest, objects: [null] },
    { ...manifest, objects: [{ ...entry, extra: 1 }] },
    { ...manifest, objects: [{ ...entry, bucket: "" }] },
    { ...manifest, objects: [entry, entry] },
    { ...manifest, objects: Array.from({ length: FACTORY_STORAGE_PRUNE_MAX_OBJECTS + 1 }, (_value, index) => ({ ...entry, key: `ordinary/run/${index}` })) },
  ];
  for (const [index, value] of rejected.entries()) {
    let error: unknown = null;
    try { assertFactoryStoragePruneManifest(value); } catch (cause) { error = cause; }
    expect([index, (error as FactoryStoragePruneError)?.code]).toEqual([index, "factory_prune_manifest_invalid"]);
  }
});

test("a manifest at the object cap is still accepted, so the cap is a bound and not a trap", () => {
  const full = Array.from({ length: FACTORY_STORAGE_PRUNE_MAX_OBJECTS }, (_value, index) => ({ ...entry, key: `ordinary/run/${index}` }));
  expect(assertFactoryStoragePruneManifest({ ...manifest, objects: full }).objects).toHaveLength(FACTORY_STORAGE_PRUNE_MAX_OBJECTS);
});

test("the tool refuses to run without a manifest", async () => {
  const child = Bun.spawn(["bun", "scripts/prune-factory-storage-manifest.ts"], {
    cwd: import.meta.dir.replace(/\/scripts$/, ""),
    env: { PATH: process.env.PATH ?? "", EZCORP_FACTORY_STORAGE_SECRETS_DIR: "/nonexistent" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("factory_prune_manifest_required");
});
