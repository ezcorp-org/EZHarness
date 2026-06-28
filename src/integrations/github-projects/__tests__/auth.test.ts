/**
 * Unit tests for resolveLinkAuth (auth.ts) — the shared host-only credential
 * resolver used by BOTH the poller daemon and the link/refresh-columns route.
 *
 * The secrets store is mocked (no real crypto/DB). The `gh auth token` shell is
 * supplied via the injectable resolver, except the two tests that exercise the
 * DEFAULT resolver by stubbing `Bun.$` (so a real `gh` shell is never spawned).
 */
import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import { GithubAuthError } from "../types";

afterAll(() => restoreModuleMocks());

let getSecretMock = mock(
  (_extensionId: string, _projectId: string | null, _name: string) =>
    Promise.resolve<string | null>(null),
);

// Superset export so a sibling spec in a shared local run can't freeze the
// module to a partial shape (CI shards each spec, so this only matters locally).
mock.module("../../../extensions/secrets-store", () => ({
  getSecret: (extensionId: string, projectId: string | null, name: string) =>
    getSecretMock(extensionId, projectId, name),
}));

const { resolveLinkAuth, boardTokenName, defaultGhAuthToken } = await import("../auth");

beforeEach(() => {
  getSecretMock = mock(() => Promise.resolve<string | null>(null));
});

const patLink = { id: "link-1", authMode: "pat" as const, projectId: "proj-1" };
const ghLink = { id: "link-1", authMode: "gh" as const, projectId: "proj-1" };

/** Temporarily replace the tagged-template shell so no real `gh` is spawned. */
function stubBunShell(output: string, sink?: string[]): () => void {
  const real = Bun.$;
  (Bun as unknown as { $: unknown }).$ = (strings: TemplateStringsArray) => {
    sink?.push(strings.join(""));
    return { text: async () => output };
  };
  return () => {
    (Bun as unknown as { $: unknown }).$ = real;
  };
}

describe("resolveLinkAuth", () => {
  test("pat mode: falls back to the SHARED project token when no per-board override", async () => {
    // No override stored (apiToken:<id> → null); shared apiToken resolves.
    getSecretMock = mock((_ext: string, _pid: string | null, name: string) =>
      Promise.resolve<string | null>(name === "apiToken" ? "ghp_shared" : null),
    );
    const auth = await resolveLinkAuth(patLink);
    expect(auth).toEqual({ mode: "pat", token: "ghp_shared" });
    // It probed the per-board override FIRST, then the shared token.
    expect(getSecretMock).toHaveBeenCalledWith("github-projects", "proj-1", boardTokenName("link-1"));
    expect(getSecretMock).toHaveBeenCalledWith("github-projects", "proj-1", "apiToken");
  });

  test("pat mode: a per-board override WINS over the shared project token", async () => {
    getSecretMock = mock((_ext: string, _pid: string | null, name: string) =>
      Promise.resolve<string | null>(
        name === boardTokenName("link-1") ? "ghp_board" : "ghp_shared",
      ),
    );
    const auth = await resolveLinkAuth(patLink);
    expect(auth).toEqual({ mode: "pat", token: "ghp_board" });
    // The override resolved → the shared token is never read.
    expect(getSecretMock).toHaveBeenCalledWith("github-projects", "proj-1", boardTokenName("link-1"));
    expect(getSecretMock).not.toHaveBeenCalledWith("github-projects", "proj-1", "apiToken");
  });

  test("pat mode: NEITHER override nor shared token (both null) throws GithubAuthError", async () => {
    getSecretMock = mock(() => Promise.resolve<string | null>(null));
    await expect(resolveLinkAuth(patLink)).rejects.toBeInstanceOf(GithubAuthError);
  });

  test("gh mode: the injected resolver supplies the bearer (trimmed)", async () => {
    const ghAuthToken = mock(() => Promise.resolve("  gho_injected\n"));
    const auth = await resolveLinkAuth(ghLink, ghAuthToken);
    expect(auth).toEqual({ mode: "gh", token: "gho_injected" });
    expect(ghAuthToken).toHaveBeenCalledTimes(1);
    // gh mode never touches the secrets store.
    expect(getSecretMock).not.toHaveBeenCalled();
  });

  test("gh mode: empty `gh auth token` output throws GithubAuthError", async () => {
    const ghAuthToken = mock(() => Promise.resolve("   \n"));
    await expect(resolveLinkAuth(ghLink, ghAuthToken)).rejects.toBeInstanceOf(GithubAuthError);
  });

  test("gh mode: the DEFAULT resolver shells out via Bun.$ (stubbed, never spawns)", async () => {
    const calls: string[] = [];
    const restore = stubBunShell("gho_default\n", calls);
    try {
      const auth = await resolveLinkAuth(ghLink);
      expect(auth).toEqual({ mode: "gh", token: "gho_default" });
      expect(calls).toEqual(["gh auth token"]);
    } finally {
      restore();
    }
  });
});

describe("defaultGhAuthToken", () => {
  test("runs `gh auth token` via Bun.$ and returns its raw output", async () => {
    const restore = stubBunShell("gho_x\n");
    try {
      expect(await defaultGhAuthToken()).toBe("gho_x\n");
    } finally {
      restore();
    }
  });
});
