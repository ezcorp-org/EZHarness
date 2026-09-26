// index.test.ts — full coverage for withoutGitContext (item C, W18 hygiene
// GC5): the one production isolation rule every host-side git wrapper and
// test helper (this package's own `../test/filesystem.ts`, the main repo's
// `src/__tests__/helpers/scratch-git.ts`, `src/extensions/git.ts`,
// `scripts/unlanded-branches.ts`, `docs/extensions/examples/docs-updater`)
// delegates to.

import { describe, expect, test } from "bun:test";
import { withoutGitContext } from "./index";

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
