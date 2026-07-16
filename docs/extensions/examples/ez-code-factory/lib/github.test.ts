import { test, expect, describe } from "bun:test";
import type { ShellResult } from "./shell";
import {
  detectProvider,
  extractHost,
  repoSlug,
  extractPRNumber,
  normalizePRState,
  normalizeMergeableState,
  normalizeCheckBucket,
  checkFailing,
  checkPending,
  mergeableResolved,
  mergeableConflict,
  makeGitHubHost,
  type GhRunner,
} from "./github";

const ok = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ShellResult => ({ exitCode: code, stdout: "", stderr });

/** A gh runner scripted by matching the first argv tokens. Records calls. */
function fakeGh(script: (args: string[]) => ShellResult): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (async (args: string[]) => {
    calls.push(args);
    return script(args);
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

describe("detectProvider", () => {
  test("github.com → github", () => {
    expect(detectProvider("https://github.com/o/n.git")).toBe("github");
    expect(detectProvider("git@GITHUB.COM:o/n.git")).toBe("github");
  });
  test("other → unknown", () => {
    expect(detectProvider("https://gitlab.com/o/n")).toBe("unknown");
  });
});

describe("extractHost", () => {
  test("empty → ''", () => expect(extractHost("  ")).toBe(""));
  test("https URL with path + userinfo", () => {
    expect(extractHost("https://git@github.com/o/n")).toBe("github.com");
  });
  test("ssh:// URL with port", () => {
    expect(extractHost("ssh://git@github.com:22/o/n")).toBe("github.com");
  });
  test("scp-like host:path", () => {
    expect(extractHost("git@github.com:o/n.git")).toBe("github.com");
  });
  test("bare host with slash, no scheme, no colon", () => {
    expect(extractHost("github.com/o/n")).toBe("github.com");
  });
  test("bare host only", () => {
    expect(extractHost("github.com")).toBe("github.com");
  });
});

describe("repoSlug", () => {
  test("https", () => expect(repoSlug("https://github.com/o/n.git")).toBe("o/n"));
  test("scp ssh", () => expect(repoSlug("git@github.com:o/n.git")).toBe("o/n"));
  test("ssh:// URL", () => expect(repoSlug("ssh://git@github.com/o/n")).toBe("o/n"));
  test("PR link uses leading two segments", () => {
    expect(repoSlug("https://github.com/o/n/pull/5")).toBe("o/n");
  });
  test("empty → ''", () => expect(repoSlug("   ")).toBe(""));
  test("scheme with no slash → ''", () => expect(repoSlug("https://github.com")).toBe(""));
  test("single segment → ''", () => expect(repoSlug("git@github.com:owneronly")).toBe(""));
  test("blank owner/name → ''", () => expect(repoSlug("https://github.com//n")).toBe(""));
});

describe("extractPRNumber", () => {
  test("github pull url", () => expect(extractPRNumber("https://github.com/o/n/pull/42")).toBe("42"));
  test("trailing slash", () => expect(extractPRNumber("https://github.com/o/n/pull/42/")).toBe("42"));
  test("non-numeric → null", () => expect(extractPRNumber("https://github.com/o/n/pull/abc")).toBeNull());
  test("empty tail → null", () => expect(extractPRNumber("")).toBeNull());
});

describe("normalizers", () => {
  test("PR state", () => {
    expect(normalizePRState("open")).toBe("OPEN");
    expect(normalizePRState(" MERGED ")).toBe("MERGED");
    expect(normalizePRState("closed")).toBe("CLOSED");
    expect(normalizePRState("weird")).toBe("UNKNOWN");
  });
  test("mergeable state + predicates", () => {
    expect(normalizeMergeableState("mergeable")).toBe("MERGEABLE");
    expect(normalizeMergeableState("conflicting")).toBe("CONFLICTING");
    expect(normalizeMergeableState("unknown")).toBe("PENDING");
    expect(mergeableResolved("MERGEABLE")).toBe(true);
    expect(mergeableResolved("CONFLICTING")).toBe(true);
    expect(mergeableResolved("PENDING")).toBe(false);
    expect(mergeableConflict("CONFLICTING")).toBe(true);
    expect(mergeableConflict("MERGEABLE")).toBe(false);
  });
  test("check bucket: explicit bucket wins", () => {
    expect(normalizeCheckBucket("pass", "IGNORED")).toBe("pass");
  });
  test("check bucket: state fallbacks", () => {
    expect(normalizeCheckBucket("", "SUCCESS")).toBe("pass");
    expect(normalizeCheckBucket("", "failure")).toBe("fail");
    expect(normalizeCheckBucket("", "IN_PROGRESS")).toBe("pending");
    expect(normalizeCheckBucket("", "CANCELLED")).toBe("cancel");
    expect(normalizeCheckBucket("", "SKIPPED")).toBe("skipping");
    expect(normalizeCheckBucket("", "mystery")).toBe("");
  });
  test("check predicates", () => {
    expect(checkFailing({ name: "a", bucket: "fail", completedAt: "" })).toBe(true);
    expect(checkFailing({ name: "a", bucket: "pass", completedAt: "" })).toBe(false);
    expect(checkPending({ name: "a", bucket: "pending", completedAt: "" })).toBe(true);
    expect(checkPending({ name: "a", bucket: "pass", completedAt: "" })).toBe(false);
  });
});

describe("GitHubHost.available", () => {
  test("authenticated → null, scopes --hostname", async () => {
    const gh = fakeGh(() => ok(""));
    const host = makeGitHubHost(gh, { host: "github.com", repo: "o/n" });
    expect(await host.available()).toBeNull();
    expect(gh.calls[0]).toEqual(["auth", "status", "--hostname", "github.com"]);
  });
  test("unauthenticated → message; no hostname when host empty", async () => {
    const gh = fakeGh(() => fail("x"));
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    expect(await host.available()).toBe("gh CLI is not authenticated");
    expect(gh.calls[0]).toEqual(["auth", "status"]);
  });
});

describe("GitHubHost.findPR", () => {
  test("found with number + base filter", async () => {
    const gh = fakeGh(() => ok(JSON.stringify([{ number: 7, url: "https://github.com/o/n/pull/7" }])));
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    const pr = await host.findPR("feat/x", "main");
    expect(pr).toEqual({ url: "https://github.com/o/n/pull/7", number: "7" });
    expect(gh.calls[0]).toContain("--base");
  });
  test("number falls back to URL tail when absent", async () => {
    const gh = fakeGh(() => ok(JSON.stringify([{ url: "https://github.com/o/n/pull/9" }])));
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    expect((await host.findPR("feat/x", ""))?.number).toBe("9");
  });
  test("empty list → null", async () => {
    const gh = fakeGh(() => ok("[]"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.findPR("b", "")).toBeNull();
  });
  test("blank url → null", async () => {
    const gh = fakeGh(() => ok(JSON.stringify([{ number: 1, url: "  " }])));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.findPR("b", "")).toBeNull();
  });
  test("malformed json → null", async () => {
    const gh = fakeGh(() => ok("not json"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.findPR("b", "")).toBeNull();
  });
  test("nonzero exit throws", async () => {
    const gh = fakeGh(() => fail("boom"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.findPR("b", "")).rejects.toThrow("gh pr list");
  });
});

describe("GitHubHost.createPR / updatePR", () => {
  test("create returns url + number, feeds body on stdin", async () => {
    let stdin = "";
    const gh = (async (_args: string[], opts?: { stdin?: string }) => {
      stdin = opts?.stdin ?? "";
      return ok("https://github.com/o/n/pull/3");
    }) as GhRunner;
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    expect(await host.createPR("b", "main", { title: "feat: x", body: "## What" })).toEqual({
      url: "https://github.com/o/n/pull/3",
      number: "3",
    });
    expect(stdin).toBe("## What");
  });
  test("create empty url → null", async () => {
    const gh = fakeGh(() => ok("  "));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.createPR("b", "main", { title: "t", body: "b" })).toBeNull();
  });
  test("create nonzero throws", async () => {
    const gh = fakeGh(() => fail("nope"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.createPR("b", "main", { title: "t", body: "b" })).rejects.toThrow("gh pr create");
  });
  test("update by number", async () => {
    const gh = fakeGh(() => ok(""));
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    const pr = { url: "u", number: "5" };
    expect(await host.updatePR(pr, { title: "t", body: "b" })).toBe(pr);
    expect(gh.calls[0]!.slice(0, 3)).toEqual(["pr", "edit", "5"]);
  });
  test("update by url when number empty", async () => {
    const gh = fakeGh(() => ok(""));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await host.updatePR({ url: "the-url", number: "" }, { title: "t", body: "b" });
    expect(gh.calls[0]!.slice(0, 3)).toEqual(["pr", "edit", "the-url"]);
  });
  test("update nonzero throws", async () => {
    const gh = fakeGh(() => fail("nope"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.updatePR({ url: "u", number: "1" }, { title: "t", body: "b" })).rejects.toThrow("gh pr edit");
  });
});

describe("GitHubHost.getPRState / getMergeableState", () => {
  test("state ok", async () => {
    const gh = fakeGh(() => ok("MERGED"));
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    expect(await host.getPRState({ url: "u", number: "1" })).toBe("MERGED");
  });
  test("state throws", async () => {
    const gh = fakeGh(() => fail("x"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.getPRState({ url: "u", number: "1" })).rejects.toThrow("gh pr view");
  });
  test("mergeable ok", async () => {
    const gh = fakeGh(() => ok("CONFLICTING"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.getMergeableState({ url: "u", number: "1" })).toBe("CONFLICTING");
  });
  test("mergeable throws", async () => {
    const gh = fakeGh(() => fail("x"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.getMergeableState({ url: "u", number: "1" })).rejects.toThrow("gh pr view mergeable");
  });
});

describe("GitHubHost.getChecks", () => {
  test("parses checks + bucket fallback", async () => {
    const gh = fakeGh(() =>
      ok(JSON.stringify([
        { name: "build", bucket: "fail", completedAt: "2026-07-16T00:00:00Z" },
        { name: "lint", state: "SUCCESS" },
      ])),
    );
    const host = makeGitHubHost(gh, { host: "", repo: "o/n" });
    const checks = await host.getChecks({ url: "u", number: "1" });
    expect(checks).toEqual([
      { name: "build", bucket: "fail", completedAt: "2026-07-16T00:00:00Z" },
      { name: "lint", bucket: "pass", completedAt: "" },
    ]);
  });
  test("no checks reported → []", async () => {
    const gh = fakeGh(() => ({ exitCode: 1, stdout: "no checks reported on the 'x' branch", stderr: "" }));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    expect(await host.getChecks({ url: "u", number: "1" })).toEqual([]);
  });
  test("nonzero (real error) throws", async () => {
    const gh = fakeGh(() => fail("boom"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.getChecks({ url: "u", number: "1" })).rejects.toThrow("gh pr checks");
  });
  test("malformed json throws", async () => {
    const gh = fakeGh(() => ok("{not-array}"));
    const host = makeGitHubHost(gh, { host: "", repo: "" });
    await expect(host.getChecks({ url: "u", number: "1" })).rejects.toThrow("parse CI checks");
  });
});

describe("GitHubHost.fetchFailedCheckLogs", () => {
  const host = (gh: GhRunner) => makeGitHubHost(gh, { host: "", repo: "o/n" });

  test("no targets → ''", async () => {
    const gh = fakeGh(() => ok(""));
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["   "])).toBe("");
    expect(gh.calls.length).toBe(0);
  });
  test("run list fails → ''", async () => {
    const gh = fakeGh(() => fail("x"));
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("");
  });
  test("run list malformed → ''", async () => {
    const gh = fakeGh((a) => (a[1] === "list" ? ok("nope") : ok("")));
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("");
  });
  test("matched run name → logs (commit flag added)", async () => {
    const gh = fakeGh((a) => {
      if (a[1] === "list") return ok(JSON.stringify([{ databaseId: 12, name: "Build" }]));
      if (a.includes("--log-failed")) return ok("FAILED: assertion");
      return ok("");
    });
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("FAILED: assertion");
    expect(gh.calls[0]).toContain("--commit");
  });
  test("no name match → '' (no headSHA → no --commit)", async () => {
    const gh = fakeGh((a) => (a[1] === "list" ? ok(JSON.stringify([{ databaseId: 12, name: "Other" }])) : ok("")));
    expect(await host(gh).fetchFailedCheckLogs("b", "", ["build"])).toBe("");
    expect(gh.calls[0]).not.toContain("--commit");
  });
  test("zero databaseId skipped", async () => {
    const gh = fakeGh((a) => (a[1] === "list" ? ok(JSON.stringify([{ databaseId: 0, name: "build" }])) : ok("")));
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("");
  });
  test("run view fails → continue → ''", async () => {
    const gh = fakeGh((a) => {
      if (a[1] === "list") return ok(JSON.stringify([{ databaseId: 3, workflowName: "build" }]));
      return fail("view-error");
    });
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("");
  });
  test("empty logs → continue → ''", async () => {
    const gh = fakeGh((a) => {
      if (a[1] === "list") return ok(JSON.stringify([{ databaseId: 3, displayTitle: "build" }]));
      return ok("   ");
    });
    expect(await host(gh).fetchFailedCheckLogs("b", "sha", ["build"])).toBe("");
  });
});
