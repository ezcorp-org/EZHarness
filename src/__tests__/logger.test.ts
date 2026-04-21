import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";

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
  });

  function freshLogger() {
    // Re-import to pick up LOG_LEVEL changes
    delete require.cache[require.resolve("../logger")];
    return require("../logger").logger;
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
});
