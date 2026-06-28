import { test, expect, describe, beforeEach, afterEach, } from "bun:test";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

describe("structured logger", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    delete process.env.LOG_LEVEL;
    delete process.env.EZCORP_DEBUG;
  });

  function freshModule() {
    // Re-import to pick up LOG_LEVEL / EZCORP_DEBUG changes
    delete require.cache[require.resolve("../logger")];
    return require("../logger");
  }

  function freshLogger() {
    return freshModule().logger;
  }

  test("logger.info writes JSON line to stdout with ts, level, msg", () => {
    const logger = freshLogger();
    logger.info("hello");
    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.ts).toBeDefined();
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  test("logger.error writes to stderr", () => {
    const logger = freshLogger();
    logger.error("oops");
    expect(stderrChunks.length).toBe(1);
    const parsed = JSON.parse(at(stderrChunks, 0, "stderr chunk"));
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("oops");
  });

  test("logger.warn writes to stderr", () => {
    const logger = freshLogger();
    logger.warn("careful");
    expect(stderrChunks.length).toBe(1);
    const parsed = JSON.parse(at(stderrChunks, 0, "stderr chunk"));
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("careful");
  });

  test("logger.debug is suppressed when LOG_LEVEL=info (default)", () => {
    const logger = freshLogger();
    logger.debug("hidden");
    expect(stdoutChunks.length).toBe(0);
    expect(stderrChunks.length).toBe(0);
  });

  test("logger.debug outputs when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const logger = freshLogger();
    logger.debug("visible");
    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
    expect(parsed.level).toBe("debug");
    expect(parsed.msg).toBe("visible");
  });

  test("logger.child('db').info includes subsystem='db'", () => {
    const logger = freshLogger();
    const child = logger.child("db");
    child.info("connected");
    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
    expect(parsed.subsystem).toBe("db");
    expect(parsed.msg).toBe("connected");
    expect(parsed.level).toBe("info");
  });

  test("extra fields passed as second arg appear in output", () => {
    const logger = freshLogger();
    logger.info("request", { method: "GET", path: "/api" });
    const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/api");
    expect(parsed.msg).toBe("request");
  });

  test("output is valid JSON (parseable by JSON.parse)", () => {
    const logger = freshLogger();
    logger.info("test");
    logger.warn("test");
    logger.error("test");
    const all = [...stdoutChunks, ...stderrChunks];
    expect(all.length).toBe(3);
    for (const chunk of all) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });

  describe("EZCORP_DEBUG per-subsystem override", () => {
    test("EZCORP_DEBUG=1 makes every subsystem's debug visible at default LOG_LEVEL", () => {
      process.env.EZCORP_DEBUG = "1";
      const logger = freshLogger();
      logger.child("anything").debug("v");
      logger.debug("top-level"); // no subsystem — still all-on under "1"
      expect(stdoutChunks.length).toBe(2);
    });

    test("EZCORP_DEBUG=* behaves like 1 (all subsystems)", () => {
      process.env.EZCORP_DEBUG = "*";
      const logger = freshLogger();
      logger.child("db").debug("v");
      expect(stdoutChunks.length).toBe(1);
    });

    test("EZCORP_DEBUG=ext selects every ext.* subsystem but not others", () => {
      process.env.EZCORP_DEBUG = "ext";
      const logger = freshLogger();
      logger.child("ext.github-projects.daemon").debug("on");
      logger.child("db").debug("off");
      expect(stdoutChunks.length).toBe(1);
      const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
      expect(parsed.subsystem).toBe("ext.github-projects.daemon");
    });

    test("EZCORP_DEBUG=ext does NOT over-match a prefix-sharing sibling (dot boundary)", () => {
      process.env.EZCORP_DEBUG = "ext";
      const logger = freshLogger();
      // "ext-other" shares the "ext" prefix but lacks the "ext." dot boundary —
      // it must stay at the global threshold (debug hidden).
      logger.child("ext-other").debug("x");
      expect(stdoutChunks.length).toBe(0);
      // A real namespaced child ("ext.x") IS selected — proving the var is live.
      logger.child("ext.x").debug("y");
      expect(stdoutChunks.length).toBe(1);
      const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
      expect(parsed.subsystem).toBe("ext.x");
    });

    test("EZCORP_DEBUG=ext.github-projects matches the whole feature namespace, not siblings", () => {
      process.env.EZCORP_DEBUG = "ext.github-projects";
      const logger = freshLogger();
      logger.child("ext.github-projects.daemon").debug("on");
      logger.child("ext.github-projects").debug("on-exact");
      logger.child("ext.web-search").debug("off");
      expect(stdoutChunks.length).toBe(2);
    });

    test("comma list with empty + exact entries; empty entries are skipped", () => {
      process.env.EZCORP_DEBUG = ",db";
      const logger = freshLogger();
      logger.child("db").debug("on");
      expect(stdoutChunks.length).toBe(1);
    });

    test("a list never matches a top-level (subsystem-less) debug line", () => {
      process.env.EZCORP_DEBUG = "ext";
      const logger = freshLogger();
      logger.debug("top-level");
      expect(stdoutChunks.length).toBe(0);
    });

    test("a non-matching list leaves the global threshold in force", () => {
      process.env.EZCORP_DEBUG = "nomatch";
      const logger = freshLogger();
      logger.child("db").debug("hidden");
      expect(stdoutChunks.length).toBe(0);
    });

    test("an empty EZCORP_DEBUG is a no-op (global LOG_LEVEL applies)", () => {
      process.env.EZCORP_DEBUG = "   ";
      const logger = freshLogger();
      logger.child("db").debug("hidden");
      expect(stdoutChunks.length).toBe(0);
    });
  });

  describe("extensionLogger standard helper", () => {
    test("namespaces under ext.<name>.<component>", () => {
      const { extensionLogger } = freshModule();
      extensionLogger("github-projects", "daemon").info("up");
      const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
      expect(parsed.subsystem).toBe("ext.github-projects.daemon");
    });

    test("omitting component yields ext.<name>", () => {
      const { extensionLogger } = freshModule();
      extensionLogger("github-projects").info("up");
      const parsed = JSON.parse(at(stdoutChunks, 0, "stdout chunk"));
      expect(parsed.subsystem).toBe("ext.github-projects");
    });

    test("EZCORP_DEBUG=ext.<name> turns on an extensionLogger's debug output", () => {
      process.env.EZCORP_DEBUG = "ext.github-projects";
      const { extensionLogger } = freshModule();
      extensionLogger("github-projects", "daemon").debug("detail");
      expect(stdoutChunks.length).toBe(1);
    });
  });
});
