import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest, pythonLockDigest, type PythonRunnerClosure } from "@ezcorp/extension-runner";
import { digestBytes } from "../../extensions/v4/blobs";

/**
 * The sealed identity of `reference.data.v1`'s isolated guest.
 *
 * Everything a run depends on is named here and nothing is resolved at
 * execution time: the exact module bytes, the committed dependency lock, the
 * importable closure the image really ships, and the image itself. C10's
 * release lock is this object plus W02's interpreter pin.
 */

/** The module the in-guest launcher imports and calls. */
export const FACTORY_REFERENCE_DATA_ENTRYPOINT = "refdata/guest.py";

/** The runner package the compiled definition names. */
export const FACTORY_REFERENCE_DATA_PACKAGE = "@ezcorp/reference-data";
export const FACTORY_REFERENCE_DATA_VERSION = "1.0.0";

/**
 * The v4 manifest name the guest really declares, which is NOT the package
 * reference above.
 *
 * `validateManifest` requires `^[a-z][a-z0-9-]{0,63}$`
 * (`packages/@ezcorp/extension-contract/src/validation.ts:126`), so no scoped
 * npm name can be a v4 manifest name; `FactoryPackagePreparations.releaseFacts`
 * (`src/factory/package-preparation.ts:84`) requires the manifest name to EQUAL
 * the runner reference's package, and the compiled definition writes
 * `@ezcorp/reference-data`. Both rules are landed and they cannot both hold, so
 * a real build must break one of them. This pack keeps the rule a real build
 * enforces and records the disagreement rather than widening either surface.
 */
export const FACTORY_REFERENCE_DATA_MANIFEST_NAME = "reference-data";

/** The four exports the definition's task nodes bind to. */
export const FACTORY_REFERENCE_DATA_EXPORTS = Object.freeze(["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"] as const);
export type FactoryReferenceDataExport = (typeof FACTORY_REFERENCE_DATA_EXPORTS)[number];

/**
 * Exactly what the pinned image reports when asked for its own importable
 * distributions. It is RECORDED, not assumed: the runner's build lane compares
 * this list with a real guest's answer and refuses to seal an artifact when
 * they differ, so an image that gained or lost a package fails the build
 * instead of reaching an attempt.
 */
export const FACTORY_REFERENCE_DATA_DISTRIBUTIONS = Object.freeze([
  "attrs==26.1.0",
  "jsonschema-specifications==2025.9.1",
  "jsonschema==4.25.1",
  "pip==25.3",
  "pyarrow==25.0.1",
  "referencing==0.37.0",
  "rpds-py==2026.6.3",
]);

/** This pack runs no model. */
export const FACTORY_REFERENCE_DATA_MODELS = Object.freeze([] as readonly string[]);

/** The release lock `scripts/build-factory-data-image.sh` records for the built image. */
export interface FactoryReferenceDataImageLock {
  readonly repository: string;
  /** Derived from the lock and the Containerfile, so a changed closure is a different tag. */
  readonly tag: string;
  /** The immutable digest reference the runner requires. */
  readonly image: string;
  /** W02's registry-digest-pinned interpreter, which this image is built from. */
  readonly base: string;
  /** `sha256:` over the committed `uv.lock` the closure was exported from. */
  readonly lockDigest: string;
}

/** The one C02 guest this pack reuses rather than reimplementing its frame loop. */
const SHARED_GUEST_MODULES = Object.freeze(["guest.py", "factory_ijson.py", "factory_schema.py", "factory_validation.py"]);
/** This pack's own modules, named explicitly so the sealed guest is exactly these bytes. */
const PACK_MODULES = Object.freeze(["refdata/__init__.py", "refdata/rows.py", "refdata/parquet.py", "refdata/guest.py", "refdata/test_sealed.py"]);
/** The generated schemas both runtimes read, so one contract serves both. */
const GENERATED_SCHEMAS = Object.freeze(["factory-runner-request.schema.json", "factory-runner-result.schema.json"]);

function repositoryRoot(): string {
  return join(import.meta.dir, "../../..");
}

function pythonProject(): string {
  return join(repositoryRoot(), "src/factory/runner/python");
}

function imageContext(): string {
  return join(import.meta.dir, "image");
}

/**
 * The recorded release lock.
 *
 * A locally built image has no registry identity until W16 publishes one, so
 * the build records the manifest digest it produced and the repository carries
 * it. A `pip install` is not byte-reproducible across machines, which means
 * this digest pins THIS deployment's image and not the world's. What pins the
 * image's MEANING anywhere is `FACTORY_REFERENCE_DATA_DISTRIBUTIONS`: the
 * runner's build lane reads the closure back out of a live guest and refuses to
 * seal an artifact when it differs.
 */
export async function factoryReferenceDataImageLock(): Promise<FactoryReferenceDataImageLock> {
  const recorded = JSON.parse(await readFile(join(imageContext(), "pinned.json"), "utf8")) as Partial<FactoryReferenceDataImageLock>;
  const { repository, tag, image, base, lockDigest } = recorded;
  if (!repository || !tag || !image || !base || !lockDigest) throw new Error("The reference data image lock is incomplete; rebuild it with scripts/build-factory-data-image.sh.");
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("The reference data image lock does not pin an immutable digest.");
  return Object.freeze({ repository, tag, image, base, lockDigest });
}

/**
 * Exactly the committed bytes one data guest runs. The build seals this map
 * into an immutable artifact, so the guest that answers an attempt is the same
 * source this repository holds and the same generated schemas the Bun runtime
 * validates against.
 *
 * The list is explicit rather than a directory walk: a sealed guest should name
 * its modules, and the repository-reading tests beside them belong to the host
 * lane, not to a guest with no repository.
 */
export async function factoryReferenceDataGuestFiles(): Promise<WorkspaceFiles> {
  const project = pythonProject();
  const files: Record<string, string> = {};
  for (const module of [...SHARED_GUEST_MODULES, ...PACK_MODULES]) files[module] = await readFile(join(project, module), "utf8");
  for (const schema of GENERATED_SCHEMAS) files[schema] = await readFile(join(repositoryRoot(), "packages/@ezcorp/factory-sdk/src", schema), "utf8");
  if (!(FACTORY_REFERENCE_DATA_ENTRYPOINT in files)) throw new Error("The reference data guest entrypoint is missing from the committed distribution.");
  return files;
}

/** The digest the build seals; a caller that stages other bytes gets a different one. */
export async function factoryReferenceDataGuestDigest(): Promise<string> {
  return filesDigest(await factoryReferenceDataGuestFiles());
}

/**
 * The tag the build script derives from the lock and the Containerfile.
 *
 * Deriving it rather than writing it down means the recorded lock cannot name a
 * closure it was not built from: change `uv.lock` or the Containerfile and the
 * expected tag moves, so a stale `pinned.json` is a detectable disagreement
 * rather than a silently wrong pin.
 */
export async function factoryReferenceDataImageTag(): Promise<string> {
  const lock = await readFile(join(pythonProject(), "uv.lock"));
  const containerfile = await readFile(join(imageContext(), "Containerfile"));
  const combined = new Uint8Array(lock.byteLength + containerfile.byteLength);
  combined.set(lock, 0);
  combined.set(containerfile, lock.byteLength);
  return digestBytes(combined).slice(0, 32);
}

/**
 * The immutable image reference an attempt runs, checked against the closure it
 * was built from. A lock that no longer matches its inputs is a readiness
 * failure, not a substitute image.
 */
export async function factoryReferenceDataImage(): Promise<string> {
  const lock = await factoryReferenceDataImageLock();
  const expected = await factoryReferenceDataImageTag();
  if (lock.tag !== expected) throw new Error(`The reference data image lock names tag ${lock.tag}, but the committed lock and Containerfile derive ${expected}. Rebuild with scripts/build-factory-data-image.sh.`);
  if (lock.lockDigest !== (await pythonLockDigest(join(pythonProject(), "uv.lock")))) throw new Error("The reference data image lock names a different uv.lock than the committed one. Rebuild with scripts/build-factory-data-image.sh.");
  return lock.image;
}

/**
 * The content lock the guest carries: the repository's interpreter pin, the
 * committed `uv.lock` by digest, the importable closure, the empty model
 * closure, and the C03 resource class.
 */
export async function factoryReferenceDataClosure(resourceClass = "cpu-small"): Promise<PythonRunnerClosure> {
  const pythonVersion = (await readFile(join(repositoryRoot(), ".python-version"), "utf8")).trim();
  return Object.freeze({
    pythonVersion,
    lockDigest: await pythonLockDigest(join(pythonProject(), "uv.lock")),
    distributions: FACTORY_REFERENCE_DATA_DISTRIBUTIONS,
    models: FACTORY_REFERENCE_DATA_MODELS,
    resourceClass,
  });
}
