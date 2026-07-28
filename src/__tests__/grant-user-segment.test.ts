/**
 * L2 — `$USER` grant segment: per-user partitioning of a shared,
 * per-extension directory.
 *
 * `extension-author` runs as ONE subprocess for every user, and its
 * drafts live at
 * `.ezcorp/extension-data/extension-author/drafts/<userId>/<draftId>/`.
 * Its grant used to be the whole `extension-author` tree, so cross-user
 * isolation rested entirely on the extension VOLUNTARILY routing through
 * the host's owner-scoped `ezcorp/drafts.resolveDir` — a compromised or
 * buggy extension that guessed another user's path would have been
 * ALLOWED by the host gate. The grant is now `drafts/$USER`.
 *
 * These drive the real enforcement functions against a real temp tree:
 * the read gate (`checkFilesystemPermission`), the write/mkdir gate
 * (`checkPrefixForWrite`), and the PDP's grant→capability flattener.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkFilesystemPermission,
  expandGrantPrefix,
  UNRESOLVED_USER_PREFIX,
} from "../extensions/permissions";
import { checkPrefixForWrite } from "../extensions/fs-handler";
import { grantsToCapabilitySet } from "../extensions/capability-types";
import type { ExtensionPermissions } from "../extensions/types";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

let root: string;
let draftsRoot: string;
let installDir: string;

/** The grant shape the bundled entry now ships. */
const grantFor = (prefix: string): ExtensionPermissions =>
  ({ filesystem: [prefix], grantedAt: {} }) as ExtensionPermissions;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "grant-user-segment-"));
  draftsRoot = join(root, "extension-data/extension-author/drafts");
  installDir = join(root, "install-dir");
  await mkdir(join(draftsRoot, ALICE, "draft-a"), { recursive: true });
  await mkdir(join(draftsRoot, BOB, "draft-b"), { recursive: true });
  await mkdir(installDir, { recursive: true });
  await writeFile(join(draftsRoot, ALICE, "draft-a", "index.ts"), "// alice");
  await writeFile(join(draftsRoot, BOB, "draft-b", "index.ts"), "// bob");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("expandGrantPrefix($USER)", () => {
  test("substitutes a whole segment with the acting user id", () => {
    expect(expandGrantPrefix("/srv/drafts/$USER", ALICE)).toBe(`/srv/drafts/${ALICE}`);
  });

  test("collapses to an unmatchable sentinel when there is no acting user", () => {
    expect(expandGrantPrefix("/srv/drafts/$USER", null)).toBe(UNRESOLVED_USER_PREFIX);
    expect(expandGrantPrefix("/srv/drafts/$USER")).toBe(UNRESOLVED_USER_PREFIX);
    // A NUL byte is not legal in a path, so it can never prefix-match.
    expect(UNRESOLVED_USER_PREFIX).toContain("\u0000");
  });

  test("leaves a non-segment occurrence alone", () => {
    // A directory legitimately named `$USERdata` is not a placeholder.
    expect(expandGrantPrefix("/srv/$USERdata", ALICE)).toBe("/srv/$USERdata");
  });

  test("prefixes without the token are untouched (existing grants unaffected)", () => {
    expect(expandGrantPrefix("/srv/shared", ALICE)).toBe("/srv/shared");
    expect(expandGrantPrefix("/srv/shared")).toBe("/srv/shared");
  });
});

describe("read gate honours the $USER partition", () => {
  const grant = () => grantFor(join(draftsRoot, "$USER"));

  test("allows the acting user's own draft", async () => {
    const r = await checkFilesystemPermission(
      join(draftsRoot, ALICE, "draft-a", "index.ts"),
      grant(), installDir, "read", ALICE,
    );
    expect(r.allowed).toBe(true);
  });

  test("DENIES another user's draft", async () => {
    const r = await checkFilesystemPermission(
      join(draftsRoot, BOB, "draft-b", "index.ts"),
      grant(), installDir, "read", ALICE,
    );
    expect(r.allowed).toBe(false);
  });

  test("DENIES the shared drafts root itself", async () => {
    const r = await checkFilesystemPermission(
      draftsRoot, grant(), installDir, "read", ALICE,
    );
    expect(r.allowed).toBe(false);
  });

  test("DENIES everything when no acting user is supplied", async () => {
    const r = await checkFilesystemPermission(
      join(draftsRoot, ALICE, "draft-a", "index.ts"),
      grant(), installDir, "read", null,
    );
    expect(r.allowed).toBe(false);
  });

  test("regression: an un-partitioned grant still allows the whole tree", async () => {
    const wide = grantFor(draftsRoot);
    const own = await checkFilesystemPermission(
      join(draftsRoot, ALICE, "draft-a", "index.ts"), wide, installDir, "read", ALICE,
    );
    const other = await checkFilesystemPermission(
      join(draftsRoot, BOB, "draft-b", "index.ts"), wide, installDir, "read", ALICE,
    );
    expect(own.allowed).toBe(true);
    // This is the pre-fix behaviour the narrowed grant removes.
    expect(other.allowed).toBe(true);
  });
});

describe("write gate honours the $USER partition", () => {
  const prefixes = () => [join(draftsRoot, "$USER")];

  test("allows a new file under the acting user's draft", async () => {
    const ok = await checkPrefixForWrite(
      join(draftsRoot, ALICE, "draft-a", "new-file.ts"),
      prefixes(), installDir, ALICE,
    );
    expect(ok).toBe(true);
  });

  test("DENIES a write into another user's draft", async () => {
    const ok = await checkPrefixForWrite(
      join(draftsRoot, BOB, "draft-b", "evil.ts"),
      prefixes(), installDir, ALICE,
    );
    expect(ok).toBe(false);
  });

  test("DENIES when no acting user is supplied", async () => {
    const ok = await checkPrefixForWrite(
      join(draftsRoot, ALICE, "draft-a", "new-file.ts"),
      prefixes(), installDir, null,
    );
    expect(ok).toBe(false);
  });
});

describe("PDP grant→capability flattening honours the $USER partition", () => {
  test("caps are rooted at the acting user's subtree", () => {
    const caps = grantsToCapabilitySet(grantFor(join(draftsRoot, "$USER")), ALICE);
    const values = caps.filter((c) => c.kind === "fs.read").map((c) => c.value);
    expect(values).toEqual([join(draftsRoot, ALICE)]);
    expect(values[0]).not.toContain(BOB);
  });

  test("no acting user ⇒ an unmatchable cap value (PDP denies)", () => {
    const caps = grantsToCapabilitySet(grantFor(join(draftsRoot, "$USER")), null);
    const values = caps.filter((c) => c.kind === "fs.read").map((c) => c.value);
    expect(values).toEqual([UNRESOLVED_USER_PREFIX]);
  });
});

describe("the shipped extension-author grant is user-partitioned", () => {
  test("bundled entry, ceiling, and on-disk manifest all agree", async () => {
    const { resolveBundledExtensions, getProjectRoot } = await import("../extensions/bundled");
    const { getCeiling } = await import("../extensions/bundled-ceiling");
    const { loadManifestFresh } = await import("../extensions/loader");

    const EXPECTED = "$CWD/.ezcorp/extension-data/extension-author/drafts/$USER";

    const entry = resolveBundledExtensions({}).find((e) => e.name === "extension-author");
    expect(entry?.permissions.filesystem).toEqual([EXPECTED]);

    // The ceiling is the hard bound — if it still listed the wide path
    // the clamp would keep granting the whole tree.
    expect(getCeiling("extension-author")?.filesystem).toEqual([EXPECTED]);

    // The on-disk manifest must match too, or the S6 drift check fires
    // on every boot.
    const manifest = await loadManifestFresh(
      join(getProjectRoot(), "docs/extensions/examples/extension-author"),
    );
    expect(manifest.permissions?.filesystem).toEqual([EXPECTED]);
  });
});
