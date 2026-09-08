import { test, expect, describe, afterAll } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useTempProjectRoot } from "./helpers/temp-project-root";
import { allowedInstallRoots, authoredExtensionsDir, downloadedExtensionsDir, isRemovableInstallPath, resolveInstallPath } from "../extensions/install-roots";

const TMP_ROOT = useTempProjectRoot("install-roots-");
afterAll(() => TMP_ROOT.cleanup());

describe("resolveInstallPath", () => {
  test("null / undefined / empty in, null out", () => {
    expect(resolveInstallPath(null)).toBeNull();
    expect(resolveInstallPath(undefined)).toBeNull();
    expect(resolveInstallPath("")).toBeNull();
  });

  test("an already-absolute path is returned unchanged (every genuinely external install)", () => {
    expect(resolveInstallPath("/opt/elsewhere/my-ext")).toBe("/opt/elsewhere/my-ext");
    // Even one that happens to sit under the resolved root: absolute means
    // "trust it verbatim", no reconstruction attempted.
    const underRoot = join(TMP_ROOT.root, "my-ext");
    expect(resolveInstallPath(underRoot)).toBe(underRoot);
  });

  test("a relative path resolves against the DEFAULT root (getProjectRoot())", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search")).toBe(
      join(TMP_ROOT.root, "docs/extensions/examples/web-search"),
    );
    expect(resolveInstallPath("extensions/ez-factory")).toBe(
      join(TMP_ROOT.root, "extensions/ez-factory"),
    );
    expect(resolveInstallPath("packages/@ezcorp/ai-kit")).toBe(
      join(TMP_ROOT.root, "packages/@ezcorp/ai-kit"),
    );
  });

  test("an explicit root argument overrides the default", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search", "/app")).toBe(
      "/app/docs/extensions/examples/web-search",
    );
  });

  test("this is the exact reconstruction of a bundled entry's resolvedPath", () => {
    // bundled.ts computes `join(getProjectRoot(), entry.path)` to READ the
    // files and persists `entry.path` via `persistPath`. resolveInstallPath
    // must invert that exactly, from whichever root the CURRENT process
    // resolves.
    const entryPath = "docs/extensions/examples/web-search";
    const resolvedAtInstallTime = join(TMP_ROOT.root, entryPath);
    expect(resolveInstallPath(entryPath)).toBe(resolvedAtInstallTime);
  });
});

describe("install-path containment predicate", () => {
  test("allowedInstallRoots is the host-owned install bases, one per writer", () => {
    expect(allowedInstallRoots()).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
    ]);
    // A registered project adds ITS `.ezcorp/extensions`, appended — the
    // static two are never displaced.
    expect(allowedInstallRoots(["/srv/proj", "relative/proj"])).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      join("/srv/proj", ".ezcorp", "extensions"),
      // A relative `projects.path` resolves against cwd like everything else.
      join(TMP_ROOT.root, "relative/proj", ".ezcorp", "extensions"),
    ]);
  });

  test("downloadedExtensionsDir stays relative (resolved against cwd)", () => {
    expect(downloadedExtensionsDir()).toBe(join("data", "extensions"));
    expect(resolve(process.cwd(), downloadedExtensionsDir())).toBe(
      allowedInstallRoots()[0],
    );
  });

  test("authoredExtensionsDir is `<root>/.ezcorp/extensions`", () => {
    expect(authoredExtensionsDir("/srv/proj")).toBe(join("/srv/proj", ".ezcorp", "extensions"));
    expect(resolve(authoredExtensionsDir(TMP_ROOT.root))).toBe(allowedInstallRoots()[1]);
  });

  test("an empty install path is refused even from INSIDE a root", async () => {
    // `resolve(cwd, "")` is `cwd`. Run from inside an allowed root and a
    // blank `install_path` would resolve to a real, contained directory —
    // i.e. "delete my working directory" — without the explicit
    // empty-string guard. Asserting it from anywhere else proves nothing:
    // a cwd outside every root is refused for the ordinary reason.
    //
    // It has to be the `.ezcorp/extensions` root, not `data/extensions`:
    // that one is cwd-RELATIVE, so chdir'ing into it moves it too.
    const inside = join(TMP_ROOT.root, ".ezcorp", "extensions", "cwd-probe");
    await mkdir(inside, { recursive: true });
    const savedCwd = process.cwd();
    process.chdir(inside);
    try {
      expect(resolve(process.cwd(), "")).toBe(inside);
      expect(isRemovableInstallPath("")).toBe(false);
      expect(isRemovableInstallPath(null)).toBe(false);
      expect(isRemovableInstallPath(undefined)).toBe(false);
      // Same cwd, a non-empty path: still contained, so the guard is
      // rejecting the EMPTY value, not the location.
      expect(isRemovableInstallPath(".")).toBe(true);
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("accepts installs inside either root, at any depth", () => {
    for (const p of [
      join("data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather", "nested"),
      join(".ezcorp", "extensions", "ai-kit"),
      join(TMP_ROOT.root, ".ezcorp", "extensions", "ai-kit"),
      // Traversal that lands back inside a root is fine — the rule is
      // about where the path RESOLVES, not how it is spelled.
      join("data", "extensions", "x", "..", "weather"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(true);
    }
  });

  test("a registered project's .ezcorp/extensions is accepted, its siblings are not", () => {
    const projectPath = join(TMP_ROOT.root, "proj");
    const roots = [projectPath];

    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"), roots)).toBe(
      true,
    );
    // Base itself, a sibling tree, and the project dir at large stay out.
    for (const p of [
      join(projectPath, ".ezcorp", "extensions"),
      join(projectPath, ".ezcorp", "extension-data", "skill"),
      join(projectPath, "src"),
      projectPath,
    ]) {
      expect(isRemovableInstallPath(p, roots)).toBe(false);
    }
    // …and without the project registered, nothing under it is removable.
    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"))).toBe(false);
  });

  test("refuses every bundled-extension install path shape", () => {
    // The 28 bundled entries resolve to `join(getProjectRoot(), entry.path)`.
    for (const relPath of [
      "docs/extensions/examples/scratchpad",
      "docs/extensions/examples/task-tracking",
      "extensions/ez-factory",
      "extensions/lessons-distiller",
      "extensions/memory-extractor",
      "packages/@ezcorp/ai-kit",
    ]) {
      expect(isRemovableInstallPath(join(TMP_ROOT.root, relPath))).toBe(false);
      expect(isRemovableInstallPath(relPath)).toBe(false);
    }
  });

  test("refuses escapes, near-misses and the roots themselves", () => {
    for (const p of [
      "../../etc",
      "/etc",
      "/home/user/extensions/notes",
      "/var/lib/extensions/",
      join("data", "extensions-backup", "weather"),
      join("data", "extensions"),
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      // Resolves back OUT of the root.
      join("data", "extensions", "..", "..", "etc"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(false);
    }
  });
});


import { collectGitHubSource } from "../extensions/source-import";

test("source credentials never reach private DNS answers or a redirect destination", async () => {
  const input = { kind: "github" as const, repository: "owner/repo" };
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fd00::1"]) {
    const { calls, fetcher } = fixture();
    await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => [address] })).rejects.toMatchObject({ reason: "private-ip" });
    expect(calls).toHaveLength(0);
  }
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
  }) as typeof fetch;
  await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ reason: "redirect-limit" });
  expect(calls).toEqual([{ url: "https://93.184.216.34/repos/owner/repo/commits/HEAD", authorization: "Bearer fixture-secret" }]);
});

function fixture(entry: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const data = url.includes("/commits/") ? { commit: { tree: { sha: "a".repeat(40) } } }
      : url.includes("/git/trees/") ? { truncated: false, tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: 24, ...entry }] }
      : { encoding: "base64", content: Buffer.from("export const extension = 4;").toString("base64") };
    return Response.json(data);
  }) as typeof fetch;
  return { calls, fetcher };
}

test("Git source import preserves binary bytes and executable mode", async () => {
  const contents = [Buffer.from("export const extension = 4;"), Buffer.from([0, 255, 137, 80, 78, 71]), Buffer.from("#!/bin/sh\nprintf asset")];
  const entries = ["extension.ts", "assets/pixel.png", "bin/helper"].map((path, index) => ({ path, mode: index === 2 ? "100755" : "100644", type: "blob", sha: String(index + 1).repeat(40), size: contents[index]!.length }));
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    if (url.includes("/git/trees/")) return Response.json({ tree: entries });
    const index = entries.findIndex(entry => url.endsWith(entry.sha));
    return Response.json({ encoding: "base64", content: contents[index]!.toString("base64") + "\n" });
  }) as typeof fetch;
  const files = await collectGitHubSource({ kind: "github", repository: "example/assets" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
  expect(files["extension.ts"]).toBe(contents[0]!.toString());
  expect(files["assets/pixel.png"]).toEqual({ encoding: "base64", data: contents[1]!.toString("base64"), executable: false });
  expect(files["bin/helper"]).toEqual({ encoding: "base64", data: contents[2]!.toString("base64"), executable: true });
});

test("fetches a pinned Git tree without checkout, redirects, or executable config", async () => {
  const { calls, fetcher } = fixture();
  const files = await collectGitHubSource({ kind: "github", repository: "example/extension", ref: "feature/new" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] });
  expect(files["extension.ts"]).toContain("extension = 4");
  expect(calls).toHaveLength(3);
  expect(calls[0]!.url).toContain("feature%2Fnew");
  expect(calls.every((call) => call.url.startsWith("https://93.184.216.34/repos/example/extension/") && new Headers(call.init?.headers).get("host") === "api.github.com" && call.init?.redirect === "manual")).toBe(true);
});

test("rejects links and submodules before fetching their contents", async () => {
  for (const entry of [{ mode: "120000" }, { type: "commit", mode: "160000" }]) {
    const { calls, fetcher } = fixture(entry);
    await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("links and submodules");
    expect(calls).toHaveLength(2);
  }
});

test("rejects arbitrary hosts, traversal, and oversized blobs", async () => {
  const { fetcher } = fixture({ size: 5 * 1024 * 1024 });
  await expect(collectGitHubSource({ kind: "github", repository: "https://localhost/repo" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("owner/repository");
  for (const repository of ["../repo", "owner/..", "./repo"]) await expect(collectGitHubSource({ kind: "github", repository }, { fetch: fetcher })).rejects.toThrow("owner/repository");
  for (const ref of ["..", ".", "branch/../private"]) await expect(collectGitHubSource({ kind: "github", repository: "owner/repo", ref }, { fetch: fetcher })).rejects.toThrow("bounded Git");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension", directory: "../private" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("traversal");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("oversized");
});

test("excludes environment files and requires a v4 entrypoint", async () => {
  const { calls, fetcher } = fixture({ path: ".env" });
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("v4 extension.ts");
  expect(calls).toHaveLength(2);
});
