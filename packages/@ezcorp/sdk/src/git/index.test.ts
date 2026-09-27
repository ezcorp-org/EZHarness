// index.test.ts — full coverage for withoutGitContext (item C, W18 hygiene
// GC5) and currentRepositoryGitContext (item C2, W18 hygiene GC5's second
// class, added after validator-3's finding that six gate scripts needed the
// invoking context KEPT, not stripped): the one production isolation rule
// every host-side git wrapper and test helper (this package's own
// `../test/filesystem.ts`, the main repo's
// `src/__tests__/helpers/scratch-git.ts`, `src/extensions/git.ts`,
// `scripts/unlanded-branches.ts`, `docs/extensions/examples/docs-updater`,
// and the six gate/coverage scripts) delegates to.

import { describe, expect, test } from "bun:test";
import { currentRepositoryGitContext, withoutGitContext } from "./index";

describe("withoutGitContext", () => {
  test("drops every GIT_*-prefixed variable", () => {
    expect(
      withoutGitContext({
        GIT_DIR: "/real/.git",
        GIT_WORK_TREE: "/real",
        GIT_INDEX_FILE: "/real/.git/index",
        GIT_COMMON_DIR: "/real/.git",
        GIT_OBJECT_DIRECTORY: "/real/.git/objects",
        GIT_PREFIX: "",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  test("keeps every non-GIT_ variable", () => {
    expect(withoutGitContext({ HOME: "/home/x", TMPDIR: "/tmp", NODE_ENV: "test" })).toEqual({
      HOME: "/home/x",
      TMPDIR: "/tmp",
      NODE_ENV: "test",
    });
  });

  test("drops undefined-valued entries (as process.env yields them)", () => {
    expect(withoutGitContext({ PATH: "/bin", UNSET: undefined })).toEqual({ PATH: "/bin" });
  });

  test("empty env in, empty env out", () => {
    expect(withoutGitContext({})).toEqual({});
  });

  test("a name merely containing GIT_ (not prefixed with it) is kept", () => {
    expect(withoutGitContext({ MY_GIT_TOKEN: "x", DIGIT_COUNT: "3" })).toEqual({
      MY_GIT_TOKEN: "x",
      DIGIT_COUNT: "3",
    });
  });
});

describe("currentRepositoryGitContext", () => {
  test("returns env completely unchanged, GIT_* vars included", () => {
    const env = {
      GIT_DIR: "/repo/.git",
      GIT_INDEX_FILE: "/repo/.git/index",
      GIT_WORK_TREE: "/repo",
      PATH: "/bin",
    };
    expect(currentRepositoryGitContext(env)).toEqual(env);
  });

  test("defaults to process.env when called with no argument", () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = "/whatever/.git";
    try {
      expect(currentRepositoryGitContext().GIT_DIR).toBe("/whatever/.git");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test("is a distinct function from withoutGitContext, not an alias of it", () => {
    expect(currentRepositoryGitContext).not.toBe(withoutGitContext as unknown as typeof currentRepositoryGitContext);
    const env = { GIT_DIR: "/repo/.git", PATH: "/bin" };
    expect(currentRepositoryGitContext(env)).toEqual(env);
    expect(withoutGitContext(env)).toEqual({ PATH: "/bin" });
  });
});
