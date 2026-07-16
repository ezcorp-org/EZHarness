/**
 * Unit coverage for the shared `installAuthoredDraft` pipeline
 * (`src/extensions/author-install.ts`) — the SINGLE secure install
 * path shared by the web form and the in-chat agent-driven install.
 *
 * Filesystem ops (existsSync/mkdir/rename) run for real against a temp
 * dir; the DB/registry/loader/verify/installer collaborators are
 * mock.module'd so each typed-error branch is driven deterministically.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mutable test doubles (swapped per test) ────────────────────────
let draftRow: Record<string, unknown> | undefined;
let consumeCalls: Array<[string, string]> = [];
let manifestImpl: (dir: string) => Promise<unknown> = async () => ({
  name: "weather",
});
let verifyImpl: () => Promise<{
  pass: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}> = async () => ({ pass: true, steps: [{ name: "x", ok: true, detail: "ok" }] });
let getByNameImpl: (n: string) => Promise<{ id: string } | null> = async () =>
  null;
let installImpl: () => Promise<{ id: string; name: string }> = async () => ({
  id: "ext-1",
  name: "weather",
});
/** Captures the args `installAuthoredDraft` hands to `installFromLocal`
 *  so the granted-permissions fold (agent-install-ux-polish item A) can
 *  be asserted. `[1]` is the granted `ExtensionPermissions`. */
let installArgs: unknown[] = [];
let updateCalls: Array<[string, Record<string, unknown>]> = [];
let reloadCalls = 0;
let reloadImpl: () => Promise<void> = async () => {};

let DRAFT_DIR = "";

mock.module("../db/queries/ez-drafts", () => ({
  getDraft: async (_id: string, _uid: string) => draftRow,
  consumeDraft: async (id: string, uid: string) => {
    consumeCalls.push([id, uid]);
    return { id };
  },
  getExtensionAuthorDraftDir: (_id: string, _uid: string) => DRAFT_DIR,
}));
mock.module("../db/queries/extensions", () => ({
  getExtensionByName: (n: string) => getByNameImpl(n),
  updateExtension: async (id: string, data: Record<string, unknown>) => {
    updateCalls.push([id, data]);
    return { id, ...data };
  },
}));
mock.module("../extensions/loader", () => ({
  loadManifest: (dir: string) => manifestImpl(dir),
}));
mock.module("../extensions/sdk/verify", () => ({
  verifyExtension: () => verifyImpl(),
}));
mock.module("../extensions/installer", () => ({
  installFromLocal: (...args: unknown[]) => {
    installArgs = args;
    return installImpl();
  },
}));
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        reloadCalls++;
        return reloadImpl();
      },
    }),
  },
}));

const { installAuthoredDraft, AuthorInstallError } = await import(
  "../extensions/author-install"
);

let TMP = "";

/** Build `<tmp>/.ezcorp/extension-data/extension-author/drafts/<u>/<d>`
 *  so dirname^6 resolves the project root to `<tmp>`. */
function seed(opts: {
  kind?: string;
  type?: string;
  withCfg?: boolean;
  makeDir?: boolean;
}): void {
  const uid = "user-a";
  const did = "draft-1";
  DRAFT_DIR = join(
    TMP,
    ".ezcorp/extension-data/extension-author/drafts",
    uid,
    did,
  );
  draftRow = {
    id: did,
    userId: uid,
    kind: opts.kind ?? "extension",
    payload: { name: "weather", type: opts.type ?? "tool", mode: "author" },
  };
  if (opts.makeDir !== false) {
    mkdirSync(DRAFT_DIR, { recursive: true });
    if (opts.withCfg !== false) {
      writeFileSync(join(DRAFT_DIR, "ezcorp.config.ts"), "export default {};\n");
    }
  }
}

beforeEach(() => {
  TMP = join(tmpdir(), `ai-install-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(TMP, { recursive: true });
  draftRow = undefined;
  consumeCalls = [];
  updateCalls = [];
  reloadCalls = 0;
  manifestImpl = async () => ({ name: "weather" });
  verifyImpl = async () => ({ pass: true, steps: [{ name: "x", ok: true, detail: "ok" }] });
  getByNameImpl = async () => null;
  installImpl = async () => ({ id: "ext-1", name: "weather" });
  installArgs = [];
  reloadImpl = async () => {};
});
afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "NO_THROW";
  } catch (e) {
    return e instanceof AuthorInstallError ? e.code : `OTHER:${String(e)}`;
  }
}

describe("installAuthoredDraft — typed-error branches", () => {
  test("DRAFT_NOT_FOUND when getDraft returns undefined", async () => {
    draftRow = undefined;
    expect(
      await code(installAuthoredDraft({ draftId: "x", userId: "u", enable: false })),
    ).toBe("DRAFT_NOT_FOUND");
  });

  test("NOT_EXTENSION_DRAFT for non-extension kind", async () => {
    seed({ kind: "agent" });
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("NOT_EXTENSION_DRAFT");
  });

  test("DRAFT_DIR_MISSING when dir absent on disk", async () => {
    seed({ makeDir: false });
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("DRAFT_DIR_MISSING");
  });

  test("MANIFEST_INVALID when ezcorp.config.ts missing", async () => {
    seed({ withCfg: false });
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("MANIFEST_INVALID");
  });

  test("MANIFEST_INVALID when loadManifest throws", async () => {
    seed({});
    manifestImpl = async () => {
      throw new Error("bad manifest");
    };
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("MANIFEST_INVALID");
  });

  test("VERIFY_FAILED when tool draft fails the smoke-test gate", async () => {
    seed({ type: "tool" });
    verifyImpl = async () => ({
      pass: false,
      steps: [{ name: "smoke-test-roundtrip", ok: false, detail: "boom" }],
    });
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("VERIFY_FAILED");
  });

  test("skill draft SKIPS verify (verify never consulted)", async () => {
    seed({ type: "skill" });
    let verifyCalled = false;
    verifyImpl = async () => {
      verifyCalled = true;
      return { pass: false, steps: [] };
    };
    const r = await installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false });
    expect(verifyCalled).toBe(false);
    expect(r.extensionId).toBe("ext-1");
  });

  test("NAME_COLLISION when an extension with the name exists", async () => {
    seed({});
    getByNameImpl = async () => ({ id: "preexisting" });
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("NAME_COLLISION");
    // Dir NOT moved (collision is pre-rename).
    expect(existsSync(DRAFT_DIR)).toBe(true);
  });

  test("ENV_KEY_LEAK is surfaced with leakedNames + dir rolled back", async () => {
    seed({});
    installImpl = async () => {
      class FakeLeak extends Error {
        readonly leakedNames = ["MY_API_KEY"];
        constructor() {
          super("Install refused: env-key-leak");
          this.name = "EnvKeyLeakInstallError";
        }
      }
      throw new FakeLeak();
    };
    try {
      await installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthorInstallError);
      const err = e as InstanceType<typeof AuthorInstallError>;
      expect(err.code).toBe("ENV_KEY_LEAK");
      expect(err.details?.leakedNames).toEqual(["MY_API_KEY"]);
    }
    // Rolled back to the draft location.
    expect(existsSync(DRAFT_DIR)).toBe(true);
  });

  test("INSTALL_FAILED for a generic installFromLocal error", async () => {
    seed({});
    installImpl = async () => {
      throw new Error("other failure");
    };
    expect(
      await code(installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false })),
    ).toBe("INSTALL_FAILED");
  });
});

describe("installAuthoredDraft — sanctioned in-place modify", () => {
  const installedDir = () => join(TMP, ".ezcorp/extensions", "weather");
  const baks = () =>
    readdirSync(join(TMP, ".ezcorp/extensions")).filter((n) =>
      n.includes(".modify-bak-"),
    );

  function asModifyDraft(modifyOf = "ext-target"): void {
    (draftRow!.payload as Record<string, unknown>).modifyOf = modifyOf;
  }
  function ownerModifiableRow(): void {
    getByNameImpl = async () =>
      ({
        id: "ext-target",
        creatorUserId: "user-a",
        modifiable: true,
        isBundled: false,
      }) as unknown as { id: string };
  }

  test("authorized modify → no collision, replaces files, cleans backup", async () => {
    seed({});
    asModifyDraft();
    ownerModifiableRow();
    mkdirSync(installedDir(), { recursive: true });
    writeFileSync(join(installedDir(), "ezcorp.config.ts"), "OLD\n");
    writeFileSync(join(DRAFT_DIR, "ezcorp.config.ts"), "NEW\n");

    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(r.extensionId).toBe("ext-1");
    expect(readFileSync(join(installedDir(), "ezcorp.config.ts"), "utf8")).toBe(
      "NEW\n",
    );
    expect(existsSync(DRAFT_DIR)).toBe(false); // moved into place
    expect(baks()).toEqual([]); // backup cleaned on success
  });

  test("backup restored when install fails (no data loss on a bad modify)", async () => {
    seed({});
    asModifyDraft();
    ownerModifiableRow();
    mkdirSync(installedDir(), { recursive: true });
    writeFileSync(join(installedDir(), "ezcorp.config.ts"), "ORIGINAL\n");
    installImpl = async () => {
      throw new Error("boom");
    };

    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("INSTALL_FAILED");
    expect(readFileSync(join(installedDir(), "ezcorp.config.ts"), "utf8")).toBe(
      "ORIGINAL\n",
    );
    expect(baks()).toEqual([]);
  });

  test("modifyOf but not owner → NAME_COLLISION (re-authorized at install)", async () => {
    seed({});
    asModifyDraft();
    getByNameImpl = async () =>
      ({
        id: "ext-target",
        creatorUserId: "someone-else",
        modifiable: true,
        isBundled: false,
      }) as unknown as { id: string };
    mkdirSync(installedDir(), { recursive: true });
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("NAME_COLLISION");
  });

  test("modifyOf but modifiable:false → NAME_COLLISION", async () => {
    seed({});
    asModifyDraft();
    getByNameImpl = async () =>
      ({
        id: "ext-target",
        creatorUserId: "user-a",
        modifiable: false,
        isBundled: false,
      }) as unknown as { id: string };
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("NAME_COLLISION");
  });

  test("modifyOf but bundled → NAME_COLLISION", async () => {
    seed({});
    asModifyDraft();
    getByNameImpl = async () =>
      ({
        id: "ext-target",
        creatorUserId: "user-a",
        modifiable: true,
        isBundled: true,
      }) as unknown as { id: string };
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("NAME_COLLISION");
  });

  test("modifyOf id mismatch (same name, different ext) → NAME_COLLISION", async () => {
    seed({});
    asModifyDraft("ext-target");
    getByNameImpl = async () =>
      ({
        id: "DIFFERENT",
        creatorUserId: "user-a",
        modifiable: true,
        isBundled: false,
      }) as unknown as { id: string };
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("NAME_COLLISION");
  });

  test("no modifyOf marker + existing → NAME_COLLISION (generic create unchanged)", async () => {
    seed({});
    getByNameImpl = async () =>
      ({
        id: "x",
        creatorUserId: "user-a",
        modifiable: true,
        isBundled: false,
      }) as unknown as { id: string };
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("NAME_COLLISION");
  });
});

describe("installAuthoredDraft — happy path + enable", () => {
  test("enable:false → no updateExtension; consumes draft; reloads registry", async () => {
    seed({});
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(r).toEqual({
      extensionId: "ext-1",
      name: "weather",
      redirectUrl: "/extensions/weather",
      // Phase 1 (agent-install-ux-polish): a valid manifest name
      // passes the host NAME_REGEX re-check, so the deep-link is
      // present and exactly `/extensions/<name>`.
      openUrl: "/extensions/weather",
    });
    expect(updateCalls.length).toBe(0);
    expect(consumeCalls).toEqual([["draft-1", "user-a"]]);
    expect(reloadCalls).toBe(1);
    // Dir moved out of the draft area.
    expect(existsSync(DRAFT_DIR)).toBe(false);
  });

  test("enable:true → updateExtension({enabled:true}) before reload", async () => {
    seed({});
    await installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: true });
    expect(updateCalls).toEqual([["ext-1", { enabled: true }]]);
    expect(reloadCalls).toBe(1);
  });

  test("registry.reload failure is non-fatal (still resolves)", async () => {
    seed({});
    reloadImpl = async () => {
      throw new Error("registry boom");
    };
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: true,
    });
    expect(r.extensionId).toBe("ext-1");
  });
});

// Phase 1 (agent-install-ux-polish) — D2 host-side NAME_REGEX
// re-check that gates the user-clickable `openUrl` deep-link.
describe("installAuthoredDraft — openUrl deep-link (D2 re-check)", () => {
  test("valid name → openUrl is exactly `/extensions/<name>`", async () => {
    seed({});
    manifestImpl = async () => ({ name: "weather-pro" });
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(r.openUrl).toBe("/extensions/weather-pro");
    // redirectUrl (web-form HTTP contract — D5) stays present too.
    expect(r.redirectUrl).toBe("/extensions/weather-pro");
  });

  test("name with dots/dashes still within NAME_REGEX → openUrl present", async () => {
    seed({});
    manifestImpl = async () => ({ name: "a0.b-c_d" });
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(r.openUrl).toBe("/extensions/a0.b-c_d");
  });

  test("forced bad name fails the re-check → openUrl OMITTED, install still succeeds", async () => {
    seed({});
    // A name that clears the loader's `typeof name === "string"`
    // guard but fails the strict host NAME_REGEX (space + `!` +
    // uppercase). Should-be-impossible in practice (validateManifestV2
    // runs upstream) — this asserts the defence-in-depth omit path.
    manifestImpl = async () => ({ name: "Bad Name!" });
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    // Install itself unaffected — only the deep-link is withheld.
    expect(r.extensionId).toBe("ext-1");
    expect(r.name).toBe("Bad Name!");
    expect("openUrl" in r).toBe(false);
    expect(r.openUrl).toBeUndefined();
  });

  test("path-traversal-shaped name is rejected by the re-check", async () => {
    seed({});
    manifestImpl = async () => ({ name: "../../etc/passwd" });
    const r = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(r.openUrl).toBeUndefined();
  });
});

// agent-install-ux-polish (item A) — the manifest's declared
// permissions are folded into the GRANTED runtime set handed to
// `installFromLocal`. Authored installs have already cleared an
// explicit user-approval gate, so an extension that correctly declares
// `permissions.network` must actually be granted it (otherwise every
// runtime fetch is denied as "missing capability"). UNCONDITIONAL —
// applies to both web-form (`enable:false`) and agent (`enable:true`)
// authored paths; both are human-consented.
describe("installAuthoredDraft — granted-permission fold (item A)", () => {
  test("declared network+filesystem → 2nd arg carries perms + grantedAt stamps", async () => {
    seed({});
    manifestImpl = async () => ({
      name: "weather",
      permissions: { network: ["api.x"], filesystem: ["/p"] },
    });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    const granted = installArgs[1] as {
      network?: string[];
      filesystem?: string[];
      grantedAt: Record<string, number>;
    };
    expect(granted.network).toEqual(["api.x"]);
    expect(granted.filesystem).toEqual(["/p"]);
    expect(typeof granted.grantedAt.network).toBe("number");
    expect(typeof granted.grantedAt.filesystem).toBe("number");
    // No timestamps minted for caps the manifest did not request.
    expect(granted.grantedAt.shell).toBeUndefined();
    expect(granted.grantedAt.env).toBeUndefined();
  });

  test("declared loopEvents → grant + grantedAt stamp minted", async () => {
    seed({});
    manifestImpl = async () => ({
      name: "loopy",
      permissions: { loopEvents: true },
    });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    const granted = installArgs[1] as {
      loopEvents?: boolean;
      grantedAt: Record<string, number>;
    };
    expect(granted.loopEvents).toBe(true);
    expect(typeof granted.grantedAt.loopEvents).toBe("number");
  });

  test("no permissions in manifest → 2nd arg is EXACTLY { grantedAt: {} } (D5 contract)", async () => {
    seed({});
    // Mirrors the D5 web-route mock (`permissions:{}`): an empty grant
    // must still satisfy `objectContaining({grantedAt:{}})`.
    manifestImpl = async () => ({ name: "weather", permissions: {} });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(installArgs[1]).toEqual({ eventSubscriptions: [], grantedAt: {} });
  });

  test("manifest with NO permissions key at all → empty grant, no throw", async () => {
    seed({});
    manifestImpl = async () => ({ name: "weather" });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    expect(installArgs[1]).toEqual({ eventSubscriptions: [], grantedAt: {} });
  });

  test("fold applies regardless of enable:true", async () => {
    seed({});
    manifestImpl = async () => ({
      name: "weather",
      permissions: { network: ["api.y"], shell: true, storage: true },
    });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: true,
    });
    const granted = installArgs[1] as {
      network?: string[];
      shell?: boolean;
      storage?: boolean;
      grantedAt: Record<string, number>;
    };
    expect(granted.network).toEqual(["api.y"]);
    expect(granted.shell).toBe(true);
    expect(granted.storage).toBe(true);
    expect(typeof granted.grantedAt.network).toBe("number");
    expect(typeof granted.grantedAt.shell).toBe("number");
    expect(typeof granted.grantedAt.storage).toBe("number");
    // enable path still flips the row on.
    expect(updateCalls).toEqual([["ext-1", { enabled: true }]]);
  });

  test("eventSubscriptions object form is normalized to its events array", async () => {
    seed({});
    manifestImpl = async () => ({
      name: "weather",
      permissions: {
        eventSubscriptions: { events: ["tool:start"], includeFullPayload: true },
      },
    });
    await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-a",
      enable: false,
    });
    const granted = installArgs[1] as {
      eventSubscriptions?: string[];
      grantedAt: Record<string, number>;
    };
    expect(granted.eventSubscriptions).toEqual(["tool:start"]);
    expect(typeof granted.grantedAt.eventSubscriptions).toBe("number");
  });

  test("env-key-leak still throws ENV_KEY_LEAK and restores the draft dir (gate intact)", async () => {
    seed({});
    manifestImpl = async () => ({
      name: "weather",
      permissions: { network: ["api.x"] },
    });
    installImpl = async () => {
      class FakeLeak extends Error {
        readonly leakedNames = ["MY_API_KEY"];
        constructor() {
          super("Install refused: env-key-leak");
          this.name = "EnvKeyLeakInstallError";
        }
      }
      throw new FakeLeak();
    };
    expect(
      await code(
        installAuthoredDraft({ draftId: "draft-1", userId: "user-a", enable: false }),
      ),
    ).toBe("ENV_KEY_LEAK");
    // Folding perms does NOT bypass the env-key-leak gate / rollback.
    expect(existsSync(DRAFT_DIR)).toBe(true);
  });
});
