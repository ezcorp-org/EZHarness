/**
 * `SettingsCredentialStore` — the `CredentialStore` pi-ai 0.83.0 runs OAuth
 * refresh inside.
 *
 * `credentials.test.ts` covers EZCorp's resolution LADDER with the pi seam
 * stubbed. This file covers the STORE itself: the settings/encryption
 * round-trip, the pi-provider-id ↔ EZCorp-provider-name translation, and —
 * the part that actually matters — `modify`'s serialization, which is what
 * makes "two concurrent turns, one token exchange" true.
 *
 * No network and no clock races: `Date.now()` is never raced, and
 * concurrency is expressed by resolving deferred promises in a chosen order
 * rather than by sleeping. A `setTimeout` here would measure the host.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

let settingsStore: Record<string, unknown> = {};
const deletedKeys: string[] = [];

mock.module("../db/queries/settings", () => ({
  getSetting: mock(async (key: string) => settingsStore[key]),
  upsertSetting: mock(async (key: string, value: unknown) => {
    settingsStore[key] = value;
  }),
  deleteSetting: mock(async (key: string) => {
    deletedKeys.push(key);
    delete settingsStore[key];
    return true;
  }),
  getAllSettings: mock(async () => ({ ...settingsStore })),
  isListingInstalled: mock(async () => false),
}));

mock.module("../providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) => {
    if (typeof ciphertext !== "string" || !ciphertext.startsWith("enc:")) {
      throw new Error("bad ciphertext");
    }
    return ciphertext.slice(4);
  }),
  _resetKeyCache: () => {},
}));

const {
  SettingsCredentialStore,
  OAuthUnusableError,
  isBrokenOAuth,
  oauthSettingKey,
  tagOAuthCredential,
  getCredentialStore,
  _resetCredentialStore,
} = await import("../providers/credential-store");

/** Store an OAuth credential the way the OAuth callback route does. */
function seed(ezProvider: string, creds: Record<string, unknown>): void {
  settingsStore[oauthSettingKey(ezProvider)] = `enc:${JSON.stringify(creds)}`;
}

const CREDS = { access: "AT", refresh: "RT", expires: 1_800_000_000_000 };

/** Re-tag a credential `modify` handed us, with a new access token. */
function withAccess(current: unknown, access: string) {
  return { ...(current as typeof CREDS), access, type: "oauth" as const };
}

beforeEach(() => {
  settingsStore = {};
  deletedKeys.length = 0;
  _resetCredentialStore();
});

describe("SettingsCredentialStore — read", () => {
  test("maps the pi provider id to EZCorp's settings key and tags the credential", async () => {
    seed("openai", CREDS);
    const got = await new SettingsCredentialStore().read("openai-codex");
    // Stored blobs predate pi's mandatory `type` tag; it is added on read.
    expect(got).toEqual({ ...CREDS, type: "oauth" });
  });

  test("undefined for an unmapped pi provider, and for a provider with nothing stored", async () => {
    const store = new SettingsCredentialStore();
    expect(await store.read("some-provider-ezcorp-never-maps")).toBeUndefined();
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  test("undefined (not a throw) when the stored value cannot be decrypted or parsed", async () => {
    // A rotated encryption secret or a hand-edited row must read as "not
    // configured" so the caller's ladder falls through to BYOK, exactly as
    // it would for a provider that was never connected.
    const store = new SettingsCredentialStore();
    settingsStore[oauthSettingKey("openai")] = "not-encrypted-at-all";
    expect(await store.read("openai-codex")).toBeUndefined();
    settingsStore[oauthSettingKey("openai")] = "enc:{ this is not json";
    expect(await store.read("openai-codex")).toBeUndefined();
    // An empty string is "nothing stored", not a parse failure.
    settingsStore[oauthSettingKey("openai")] = "";
    expect(await store.read("openai-codex")).toBeUndefined();
  });
});

describe("SettingsCredentialStore — list", () => {
  test("reports only providers that actually have a stored credential", async () => {
    const store = new SettingsCredentialStore();
    expect(await store.list()).toEqual([]);
    seed("openai", CREDS);
    seed("anthropic", CREDS);
    const listed = [...(await store.list())].sort((a, b) =>
      a.providerId.localeCompare(b.providerId),
    );
    expect(listed).toEqual([
      { providerId: "anthropic", type: "oauth" },
      { providerId: "openai-codex", type: "oauth" },
    ]);
  });
});

describe("SettingsCredentialStore — modify", () => {
  test("persists what `fn` returns, encrypted, under the EZCorp key", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    const next = { ...CREDS, access: "AT2", type: "oauth" as const };
    const post = await store.modify("openai-codex", async () => next);
    expect(post).toEqual(next);
    expect(settingsStore[oauthSettingKey("openai")]).toBe(`enc:${JSON.stringify(next)}`);
  });

  test("`fn` sees the CURRENT credential", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    let seen: unknown;
    await store.modify("openai-codex", async (current) => {
      seen = current;
      return undefined;
    });
    expect(seen).toEqual({ ...CREDS, type: "oauth" });
  });

  test("returning undefined leaves the stored value byte-identical", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    const before = settingsStore[oauthSettingKey("openai")];
    const post = await store.modify("openai-codex", async () => undefined);
    expect(post).toEqual({ ...CREDS, type: "oauth" });
    expect(settingsStore[oauthSettingKey("openai")]).toBe(before);
  });

  test("an unmapped provider is a no-op that writes nothing", async () => {
    const store = new SettingsCredentialStore();
    const post = await store.modify("not-a-provider", async () => ({
      ...CREDS,
      type: "oauth" as const,
    }));
    expect(post).toBeUndefined();
    expect(Object.keys(settingsStore)).toEqual([]);
  });

  test("a rejection from `fn` propagates AND leaves the credential intact for retry", async () => {
    // pi depends on this: a failed refresh must not destroy the credential,
    // because re-login is the fix and the old token is still the user's.
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    const before = settingsStore[oauthSettingKey("openai")];
    await expect(
      store.modify("openai-codex", async () => {
        throw new Error("invalid_grant");
      }),
    ).rejects.toThrow("invalid_grant");
    expect(settingsStore[oauthSettingKey("openai")]).toBe(before);
  });
});

describe("SettingsCredentialStore — serialization (the reason this class exists)", () => {
  test("a queued caller sees the FIRST caller's write, so it can decline to redo the work", async () => {
    // This is the property `Models.getAuth()` relies on to stop a
    // double-refresh: the second `fn` re-checks expiry INSIDE the lock and
    // returns undefined because the first one already refreshed.
    //
    // Ordering is forced by a deferred promise, never by a timer — under the
    // parallel test pool a sleep measures the host, not the code.
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const seenBySecond: unknown[] = [];
    let exchanges = 0;

    const first = store.modify("openai-codex", async (current) => {
      await firstGate; // hold the lock open until we say so
      exchanges += 1;
      return withAccess(current, "REFRESHED");
    });

    const second = store.modify("openai-codex", async (current) => {
      seenBySecond.push(current);
      // "Already fresh" — decline, exactly as pi's re-check does.
      if ((current as { access?: string }).access === "REFRESHED") return undefined;
      exchanges += 1;
      return withAccess(current, "SECOND");
    });

    releaseFirst();
    const [firstPost, secondPost] = await Promise.all([first, second]);

    // The second call ran AFTER the first committed, and saw its write.
    expect(seenBySecond).toEqual([{ ...CREDS, access: "REFRESHED", type: "oauth" }]);
    expect((firstPost as { access: string }).access).toBe("REFRESHED");
    expect((secondPost as { access: string }).access).toBe("REFRESHED");
    // One exchange for two concurrent callers.
    expect(exchanges).toBe(1);
  });

  test("a rejected turn does not wedge the queue behind it", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);

    const failing = store.modify("openai-codex", async () => {
      throw new Error("boom");
    });
    const following = store.modify("openai-codex", async (current) =>
      withAccess(current, "AFTER"),
    ) as Promise<{ access: string }>;

    await expect(failing).rejects.toThrow("boom");
    expect((await following).access).toBe("AFTER");
  });

  test("different providers do not contend with each other", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    seed("anthropic", CREDS);

    let releaseOpenAI!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpenAI = resolve;
    });

    const held = store.modify("openai-codex", async (current) => {
      await gate;
      return withAccess(current, "OPENAI");
    });
    // Completes while the openai chain is still held — proving the lock is
    // per-provider, not global.
    const other = (await store.modify("anthropic", async (current) =>
      withAccess(current, "ANTHROPIC"),
    )) as { access: string };
    expect(other.access).toBe("ANTHROPIC");

    releaseOpenAI();
    expect(((await held) as { access: string }).access).toBe("OPENAI");
  });
});

describe("SettingsCredentialStore — delete", () => {
  test("removes the credential row", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    await store.delete("openai-codex");
    expect(deletedKeys).toContain(oauthSettingKey("openai"));
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  test("an unmapped provider deletes nothing", async () => {
    const store = new SettingsCredentialStore();
    seed("openai", CREDS);
    await store.delete("not-a-provider");
    expect(deletedKeys).toEqual([]);
    expect(await store.read("openai-codex")).toBeDefined();
  });
});

describe("getCredentialStore singleton", () => {
  test("returns one instance so the per-provider chains are shared", () => {
    expect(getCredentialStore()).toBe(getCredentialStore());
  });

  test("_resetCredentialStore drops it", () => {
    const before = getCredentialStore();
    _resetCredentialStore();
    expect(getCredentialStore()).not.toBe(before);
  });
});

describe("broken-vs-unconfigured classification", () => {
  test("isBrokenOAuth is true for OAuthUnusableError and for pi's code:'oauth'", () => {
    expect(isBrokenOAuth(new OAuthUnusableError("expired, no refresh token"))).toBe(true);
    expect(isBrokenOAuth(Object.assign(new Error("refresh failed"), { code: "oauth" }))).toBe(true);
  });

  test("isBrokenOAuth is false for a plain 'not configured' error and for non-errors", () => {
    expect(isBrokenOAuth(new Error("No OAuth token for openai"))).toBe(false);
    expect(isBrokenOAuth(Object.assign(new Error("x"), { code: "auth" }))).toBe(false);
    expect(isBrokenOAuth(undefined)).toBe(false);
    expect(isBrokenOAuth(null)).toBe(false);
    expect(isBrokenOAuth("a string")).toBe(false);
  });

  test("OAuthUnusableError keeps its name and cause", () => {
    const cause = new Error("root");
    const err = new OAuthUnusableError("wrapper", { cause });
    expect(err.name).toBe("OAuthUnusableError");
    expect(err.cause).toBe(cause);
  });
});

describe("tagOAuthCredential", () => {
  test("adds the type tag without mutating or dropping fields", () => {
    const stored = { access: "A", refresh: "R", expires: 1, projectId: "p" };
    const tagged = tagOAuthCredential(stored);
    expect(tagged).toEqual({ ...stored, type: "oauth" });
    expect(stored).not.toHaveProperty("type"); // read-time adaptation, not a migration
  });
});
