import { describe, expect, test } from "bun:test";
import {
  CONFIG_SCHEMA_VERSION,
  NON_REMOVABLE_IGNORES,
  NOT_VISIBLE_MESSAGE,
  addFolder,
  addFolderIgnore,
  addFolderRule,
  checkReachability,
  containsEzcorpData,
  effectiveIgnores,
  emptyConfig,
  isIgnored,
  isWithin,
  normalizeFolderPath,
  removeFolder,
  setBacklogPolicy,
  setFolderMode,
  toggleFolderPreset,
  validateConfig,
  type Config,
} from "./config";
import type { Rule } from "./rules";

let counter = 0;
const idGen = () => `f${counter++}`;

function add(config: Config, path: string, extra: Partial<Parameters<typeof addFolder>[1]> = {}) {
  return addFolder(config, { path, backlogPolicy: "new-only", now: 1000, idGen, ...extra });
}

describe("normalizeFolderPath", () => {
  test("collapses .. and trailing slash", () => {
    expect(normalizeFolderPath("/a/b/../c/")).toBe("/a/c");
  });
  test("rejects relative paths", () => {
    expect(normalizeFolderPath("rel/path")).toBeNull();
  });
  test("rejects control chars", () => {
    expect(normalizeFolderPath("/a\x00b")).toBeNull();
    expect(normalizeFolderPath("/a\nb")).toBeNull();
  });
  test("rejects empty", () => {
    expect(normalizeFolderPath("")).toBeNull();
  });
});

describe("isWithin / isIgnored / containsEzcorpData", () => {
  test("isWithin", () => {
    expect(isWithin("/a", "/a/b")).toBe(true);
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/a", "/ab")).toBe(false);
  });
  test("relative ignore matches a path segment run", () => {
    expect(isIgnored("/x/node_modules/pkg", ["node_modules"])).toBe(true);
    expect(isIgnored("/x/.ezcorp/data/db", [".ezcorp/data"])).toBe(true);
    expect(isIgnored("/x/src", ["node_modules"])).toBe(false);
  });
  test("absolute ignore matches a prefix", () => {
    expect(isIgnored("/secret/a", ["/secret"])).toBe(true);
    expect(isIgnored("/other/a", ["/secret"])).toBe(false);
  });
  test("containsEzcorpData", () => {
    expect(containsEzcorpData("/proj/.ezcorp/data")).toBe(true);
    expect(containsEzcorpData("/proj/Downloads")).toBe(false);
  });
});

describe("checkReachability (container-visibility probe)", () => {
  const visible = (p: string) => p === "/watched/Downloads";
  test("visible path ⇒ ok", () => {
    const r = checkReachability("/watched/Downloads", visible);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/watched/Downloads");
  });
  test("not-visible path ⇒ the mount-it message", () => {
    const r = checkReachability("/watched/NotMounted", visible);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(NOT_VISIBLE_MESSAGE);
  });
  test("relative path ⇒ rejected before the probe", () => {
    const r = checkReachability("relative/path", () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("absolute");
  });
  test(".ezcorp/data ⇒ refused even if visible", () => {
    const r = checkReachability("/proj/.ezcorp/data", () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".ezcorp/data");
  });
});

describe("addFolder guards", () => {
  test("happy path stamps epochMs for new-only", () => {
    const r = add(emptyConfig(), "/watched/Downloads");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.folders[0]!.path).toBe("/watched/Downloads");
      expect(r.config.folders[0]!.epochMs).toBe(1000);
    }
  });
  test("include-existing does not stamp epochMs", () => {
    const r = add(emptyConfig(), "/watched/X", { backlogPolicy: "include-existing" });
    expect(r.ok && r.config.folders[0]!.epochMs).toBeUndefined();
  });
  test("refuses .ezcorp/data folder", () => {
    const r = add(emptyConfig(), "/proj/.ezcorp/data");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".ezcorp/data");
  });
  test("refuses non-absolute", () => {
    const r = add(emptyConfig(), "relative");
    expect(r.ok).toBe(false);
  });
  test("refuses a descendant of an existing folder", () => {
    const base = add(emptyConfig(), "/watched");
    expect(base.ok).toBe(true);
    if (base.ok) {
      const r = add(base.config, "/watched/sub");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Already covered");
    }
  });
  test("refuses exact duplicate", () => {
    const base = add(emptyConfig(), "/watched");
    if (base.ok) {
      const r = add(base.config, "/watched");
      expect(r.ok).toBe(false);
    }
  });
  test("ancestor drops existing descendants (keep ancestor)", () => {
    let c = emptyConfig();
    const a = add(c, "/watched/sub");
    if (a.ok) c = a.config;
    const b = add(c, "/watched");
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.config.folders).toHaveLength(1);
      expect(b.config.folders[0]!.path).toBe("/watched");
    }
  });
  test("filters unknown presets", () => {
    const r = add(emptyConfig(), "/watched/Y", { presets: ["junk-sweep", "bogus"] });
    expect(r.ok && r.config.folders[0]!.presets).toEqual(["junk-sweep"]);
  });
});

describe("mutators", () => {
  function seed() {
    const r = add(emptyConfig(), "/watched/Downloads");
    if (!r.ok) throw new Error("seed failed");
    return { config: r.config, id: r.config.folders[0]!.id };
  }

  test("removeFolder", () => {
    const { config, id } = seed();
    expect(removeFolder(config, id).folders).toHaveLength(0);
    expect(removeFolder(config, "nope").folders).toHaveLength(1);
  });
  test("setFolderMode (valid + invalid)", () => {
    const { config, id } = seed();
    expect(setFolderMode(config, id, "fully-auto").folders[0]!.mode).toBe("fully-auto");
    expect(setFolderMode(config, id, "bogus" as never).folders[0]!.mode).toBeUndefined();
  });
  test("toggleFolderPreset on/off + unknown", () => {
    const { config, id } = seed();
    const on = toggleFolderPreset(config, id, "junk-sweep");
    expect(on.folders[0]!.presets).toContain("junk-sweep");
    const off = toggleFolderPreset(on, id, "junk-sweep");
    expect(off.folders[0]!.presets).not.toContain("junk-sweep");
    expect(toggleFolderPreset(config, id, "bogus").folders[0]!.presets).toHaveLength(0);
  });
  test("setBacklogPolicy stamps/clears epochMs", () => {
    const { config, id } = seed();
    const inc = setBacklogPolicy(config, id, "include-existing", 5000);
    expect(inc.folders[0]!.epochMs).toBeUndefined();
    const back = setBacklogPolicy(inc, id, "new-only", 9000);
    expect(back.folders[0]!.epochMs).toBe(9000);
  });
  test("addFolderIgnore dedups + skips empty", () => {
    const { config, id } = seed();
    const once = addFolderIgnore(config, id, "secret");
    expect(addFolderIgnore(once, id, "secret").folders[0]!.ignore).toEqual(["secret"]);
    expect(addFolderIgnore(config, id, "  ").folders[0]!.ignore).toHaveLength(0);
  });
  test("addFolderRule dedups by id", () => {
    const { config, id } = seed();
    const rule: Rule = { id: "r1", label: "x", action: "route", predicate: { glob: "*.x" }, destructive: false };
    const once = addFolderRule(config, id, rule);
    expect(addFolderRule(once, id, rule).folders[0]!.customRules).toHaveLength(1);
  });
  test("effectiveIgnores merges non-removable + global + folder", () => {
    const { config, id } = seed();
    const withGlobal: Config = { ...config, globalIgnore: [...config.globalIgnore, "globalX"] };
    const withFolder = addFolderIgnore(withGlobal, id, "folderY");
    const eff = effectiveIgnores(withFolder, withFolder.folders[0]!);
    for (const ig of NON_REMOVABLE_IGNORES) expect(eff).toContain(ig);
    expect(eff).toContain("globalX");
    expect(eff).toContain("folderY");
  });
});

describe("validateConfig", () => {
  test("non-object → empty config", () => {
    expect(validateConfig(null).folders).toHaveLength(0);
    expect(validateConfig(42).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });
  test("drops malformed folders + .ezcorp/data", () => {
    const cfg = validateConfig({
      folders: [
        { path: "/watched/A", backlogPolicy: "new-only" },
        { path: "relative" },
        { path: "/proj/.ezcorp/data" },
        { nopath: true },
      ],
    });
    expect(cfg.folders).toHaveLength(1);
    expect(cfg.folders[0]!.path).toBe("/watched/A");
  });
  test("normalizes overlaps (keeps ancestor)", () => {
    const cfg = validateConfig({
      folders: [
        { path: "/watched/sub" },
        { path: "/watched" },
      ],
    });
    expect(cfg.folders).toHaveLength(1);
    expect(cfg.folders[0]!.path).toBe("/watched");
  });
  test("re-applies non-removable ignores + dedups global", () => {
    const cfg = validateConfig({ folders: [], globalIgnore: [".git", "custom", "custom"] });
    for (const ig of NON_REMOVABLE_IGNORES) expect(cfg.globalIgnore).toContain(ig);
    expect(cfg.globalIgnore.filter((x) => x === "custom")).toHaveLength(1);
  });
  test("preserves valid mode + presets + epochMs", () => {
    const cfg = validateConfig({
      folders: [{ path: "/w", mode: "fully-auto", presets: ["junk-sweep", "bad"], epochMs: 77, backlogPolicy: "include-existing" }],
    });
    expect(cfg.folders[0]!.mode).toBe("fully-auto");
    expect(cfg.folders[0]!.presets).toEqual(["junk-sweep"]);
    expect(cfg.folders[0]!.epochMs).toBe(77);
    expect(cfg.folders[0]!.backlogPolicy).toBe("include-existing");
  });
});
