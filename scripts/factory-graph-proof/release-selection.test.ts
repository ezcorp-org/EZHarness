import { expect, test } from "bun:test";
import { digestObject } from "../../src/extensions/v4/blobs";
import { referenceCodeRunnerPackageFiles } from "../../src/factory/reference-code/runner-packages";
import { expectedRunnerSourceDigest, ReleaseSelectionError, selectStagedRelease } from "./release-selection";

const EXPECTED = "a".repeat(64), OTHER = "b".repeat(64);
const release = (id: string, sourceDigest: string, createdAt: string) => ({ id, sourceDigest, createdAt });

test("the expected digest is the digest of the bundled runner source, exactly as the boot stages it", async () => {
  expect(await expectedRunnerSourceDigest("reference-code")).toBe(digestObject(await referenceCodeRunnerPackageFiles("reference-code")));
});

test("the newest release WITH the expected source digest is picked; a newer release of other bytes never is", () => {
  const releases = {
    old: release("old", EXPECTED, "2026-10-14T20:12:35.665Z"),
    other: release("other", OTHER, "2026-10-15T15:00:00.000Z"),
    newest: release("newest", EXPECTED, "2026-10-15T14:52:24.967Z"),
  };
  expect(selectStagedRelease(releases, EXPECTED)).toBe("newest");
});

test("no release with the expected digest is a named failure, never another release", () => {
  const error = (() => { try { selectStagedRelease({ other: release("other", OTHER, "2026-10-15T15:00:00.000Z") }, EXPECTED); } catch (caught) { return caught; } })();
  expect(error).toBeInstanceOf(ReleaseSelectionError);
  expect(error).toMatchObject({ code: "release_digest_mismatch", expected: EXPECTED, staged: [OTHER] });
  expect(() => selectStagedRelease(undefined, EXPECTED)).toThrow("release_digest_mismatch");
});
