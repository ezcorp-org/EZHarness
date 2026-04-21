import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startStubServer, type StubServer } from "../fixtures/stub-server";
import { doctor, type CheckResult } from "../../src/cli/doctor";

// Capture console output so assertions can inspect it without polluting test output
function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

// ── happy path (auth present) ─────────────────────────────────────────────────

describe("doctor — all checks pass", () => {
  let stub: StubServer;
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    stub = startStubServer({ apiKey: "test-key" });
    cap = captureConsole();
  });
  afterEach(() => {
    stub.stop();
    cap.restore();
  });

  test("returns true when backend healthy + auth valid", async () => {
    const ok = await doctor({ baseUrl: stub.url, apiKey: "test-key" });
    expect(ok).toBe(true);
  });

  test("prints 'All checks passed' line", async () => {
    await doctor({ baseUrl: stub.url, apiKey: "test-key" });
    const output = cap.logs.join("\n");
    expect(output).toContain("All checks passed");
  });

  test("prints health check row with ok status", async () => {
    await doctor({ baseUrl: stub.url, apiKey: "test-key" });
    const output = cap.logs.join("\n");
    expect(output).toContain("/api/health");
    expect(output).toContain("ok");
  });

  test("prints auth row with user info", async () => {
    await doctor({ baseUrl: stub.url, apiKey: "test-key" });
    const output = cap.logs.join("\n");
    expect(output).toContain("/api/auth/me");
    expect(output).toContain("stub@example.com");
  });

  test("prints mcp tools row", async () => {
    await doctor({ baseUrl: stub.url, apiKey: "test-key" });
    const output = cap.logs.join("\n");
    expect(output).toContain("mcp tools");
  });
});

// ── auth missing ──────────────────────────────────────────────────────────────

describe("doctor — no API key", () => {
  let stub: StubServer;
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    stub = startStubServer(); // no auth required
    cap = captureConsole();
  });
  afterEach(() => {
    stub.stop();
    cap.restore();
  });

  test("returns true when backend healthy and no apiKey", async () => {
    const ok = await doctor({ baseUrl: stub.url });
    expect(ok).toBe(true);
  });

  test("auth row shows 'skipped' message", async () => {
    await doctor({ baseUrl: stub.url });
    const output = cap.logs.join("\n");
    expect(output).toContain("skipped");
  });
});

// ── server down ───────────────────────────────────────────────────────────────

describe("doctor — server unreachable", () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => { cap = captureConsole(); });
  afterEach(() => cap.restore());

  test("returns false when backend is down", async () => {
    // Port 1 is almost certainly not listening
    const ok = await doctor({ baseUrl: "http://127.0.0.1:1", apiKey: undefined });
    expect(ok).toBe(false);
  });

  test("prints failure message", async () => {
    await doctor({ baseUrl: "http://127.0.0.1:1" });
    const output = cap.logs.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("checks failed");
  });
});

// ── auth fails (wrong key) ────────────────────────────────────────────────────

describe("doctor — wrong API key", () => {
  let stub: StubServer;
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    stub = startStubServer({ apiKey: "correct-key" });
    cap = captureConsole();
  });
  afterEach(() => {
    stub.stop();
    cap.restore();
  });

  test("health passes but auth row fails, returns false", async () => {
    const ok = await doctor({ baseUrl: stub.url, apiKey: "wrong-key" });
    expect(ok).toBe(false);
  });

  test("prints FAIL on auth row", async () => {
    await doctor({ baseUrl: stub.url, apiKey: "wrong-key" });
    const output = cap.logs.join("\n");
    expect(output).toContain("FAIL");
  });
});
