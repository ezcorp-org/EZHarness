import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import {
  factoryReadinessCheck,
  factoryReadinessCheckDependencies,
  startFactoryReadinessCheck,
  type FactoryReadinessCheckDependencies,
} from "./readiness-check";

interface Calls { readFile: string[]; connect: [string, number, number][]; fetchStatus: [string, number][] }

function fakes(overrides: Partial<FactoryReadinessCheckDependencies> = {}): { dependencies: FactoryReadinessCheckDependencies; calls: Calls } {
  const calls: Calls = { readFile: [], connect: [], fetchStatus: [] };
  const dependencies: FactoryReadinessCheckDependencies = {
    readFile: async (path) => { calls.readFile.push(path); return overrides.readFile ? overrides.readFile(path) : '{"lifecycle":"ready"}'; },
    connect: async (host, port, timeoutMs) => { calls.connect.push([host, port, timeoutMs]); return overrides.connect ? overrides.connect(host, port, timeoutMs) : true; },
    fetchStatus: async (url, timeoutMs) => { calls.fetchStatus.push([url, timeoutMs]); return overrides.fetchStatus ? overrides.fetchStatus(url, timeoutMs) : 200; },
  };
  return { dependencies, calls };
}

describe("factoryReadinessCheck --tcp", () => {
  test("splits host and port at the last colon and uses a 4 second timeout", async () => {
    const { dependencies, calls } = fakes();
    expect(await factoryReadinessCheck(["--tcp", "postgres:5432"], dependencies)).toBe(true);
    expect(await factoryReadinessCheck(["--tcp", "::1:1"], dependencies)).toBe(true);
    expect(await factoryReadinessCheck(["--tcp", "h:65535"], dependencies)).toBe(true);
    expect(calls.connect).toEqual([["postgres", 5432, 4_000], ["::1", 1, 4_000], ["h", 65_535, 4_000]]);
  });

  test("reports a refused connection as not healthy", async () => {
    const { dependencies } = fakes({ connect: async () => false });
    expect(await factoryReadinessCheck(["--tcp", "db:5432"], dependencies)).toBe(false);
  });

  test("a throwing connector is not healthy", async () => {
    const { dependencies } = fakes({ connect: async () => { throw new Error("boom"); } });
    expect(await factoryReadinessCheck(["--tcp", "db:5432"], dependencies)).toBe(false);
  });

  test("malformed targets never reach the connector", async () => {
    const { dependencies, calls } = fakes();
    for (const target of ["noport", ":5432", "h:0", "h:65536", "h:-1", "h:abc", "h:1.5", "h:"]) {
      expect(await factoryReadinessCheck(["--tcp", target], dependencies)).toBe(false);
    }
    expect(await factoryReadinessCheck(["--tcp"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--tcp", ""], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--tcp", "h:1", "extra"], dependencies)).toBe(false);
    expect(calls.connect).toEqual([]);
  });
});

describe("factoryReadinessCheck --http", () => {
  test("only status 200 is healthy", async () => {
    for (const [status, healthy] of [[200, true], [204, false], [302, false], [500, false]] as const) {
      const { dependencies, calls } = fakes({ fetchStatus: async () => status });
      expect(await factoryReadinessCheck(["--http", "http://svc/ready"], dependencies)).toBe(healthy);
      expect(calls.fetchStatus).toEqual([["http://svc/ready", 4_000]]);
    }
  });

  test("a fetch failure is not healthy; a missing or extra argument is refused", async () => {
    const { dependencies, calls } = fakes({ fetchStatus: async () => { throw new TypeError("fetch failed"); } });
    expect(await factoryReadinessCheck(["--http", "http://svc/ready"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--http"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--http", "http://svc/ready", "x"], dependencies)).toBe(false);
    expect(calls.fetchStatus).toHaveLength(1);
  });
});

describe("factoryReadinessCheck readiness record", () => {
  test("healthy only when the lifecycle field is exactly ready", async () => {
    const cases: [string, boolean][] = [
      ['{"lifecycle":"ready"}', true],
      ['{"lifecycle":"starting"}', false],
      ['{"lifecycle":"READY"}', false],
      ['{"lifecycle":true}', false],
      ["{}", false],
      ["null", false],
      ["not json", false],
    ];
    for (const [content, healthy] of cases) {
      const { dependencies, calls } = fakes({ readFile: async () => content });
      expect(await factoryReadinessCheck(["/run/ready.json"], dependencies)).toBe(healthy);
      expect(calls.readFile).toEqual(["/run/ready.json"]);
    }
  });

  test("an unreadable record is not healthy", async () => {
    const { dependencies } = fakes({ readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
    expect(await factoryReadinessCheck(["/run/missing.json"], dependencies)).toBe(false);
  });

  test("no argument, an unknown flag, or extra arguments are refused without any probe", async () => {
    const { dependencies, calls } = fakes();
    expect(await factoryReadinessCheck([], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--unix"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["--unix", "/sock"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck(["/run/ready.json", "extra"], dependencies)).toBe(false);
    expect(await factoryReadinessCheck([""], dependencies)).toBe(false);
    expect(calls).toEqual({ readFile: [], connect: [], fetchStatus: [] });
  });
});

describe("factoryReadinessCheckDependencies against real local services", () => {
  let root: string;
  let tcp: Bun.TCPSocketListener<undefined>;
  let http: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/ready") return new Response("ok");
        if (path === "/redirect") return Response.redirect("/ready", 302);
        return new Response("down", { status: 503 });
      },
    });
  });

  afterAll(async () => {
    tcp.stop(true);
    await http.stop(true);
    await removeFactoryPrivateRoot(root);
  });

  test("readFile reads a real readiness record", async () => {
    const path = await writeModeFile(join(root, "ready.json"), JSON.stringify({ lifecycle: "ready", pid: 1 }));
    expect(await factoryReadinessCheckDependencies.readFile(path)).toBe('{"lifecycle":"ready","pid":1}');
    expect(await factoryReadinessCheck([path], factoryReadinessCheckDependencies)).toBe(true);
    const stopping = await writeModeFile(join(root, "stopping.json"), JSON.stringify({ lifecycle: "stopping" }));
    expect(await factoryReadinessCheck([stopping], factoryReadinessCheckDependencies)).toBe(false);
    expect(await factoryReadinessCheck([join(root, "absent.json")], factoryReadinessCheckDependencies)).toBe(false);
  });

  test("connect succeeds against a listener and fails against a closed port", async () => {
    expect(await factoryReadinessCheckDependencies.connect("127.0.0.1", tcp.port, 4_000)).toBe(true);
    expect(await factoryReadinessCheck(["--tcp", `127.0.0.1:${tcp.port}`], factoryReadinessCheckDependencies)).toBe(true);
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const closedPort = closed.port;
    closed.stop(true);
    expect(await factoryReadinessCheckDependencies.connect("127.0.0.1", closedPort, 4_000)).toBe(false);
  });

  test("connect gives up with false when the listener never completes the handshake", async () => {
    // A raw socket that listens with backlog 0 and never accepts: once its one
    // queue slot is taken, the kernel drops further SYNs, so the probe can only
    // end through its own timeout.
    const libc = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const fd = libc.symbols.socket(2, 1, 0); // AF_INET, SOCK_STREAM
    try {
      const address = new Uint8Array(16);
      address[0] = 2; // sin_family = AF_INET (little-endian), port 0
      address.set([127, 0, 0, 1], 4);
      expect(libc.symbols.bind(fd, ptr(address), 16)).toBe(0);
      expect(libc.symbols.listen(fd, 0)).toBe(0);
      expect(libc.symbols.getsockname(fd, ptr(address), ptr(new Uint32Array([16])))).toBe(0);
      const port = (address[2]! << 8) | address[3]!;
      expect(await factoryReadinessCheckDependencies.connect("127.0.0.1", port, 4_000)).toBe(true);
      expect(await factoryReadinessCheckDependencies.connect("127.0.0.1", port, 200)).toBe(false);
    } finally {
      libc.symbols.close(fd);
      libc.close();
    }
  });

  test("concurrent probes against one listener all succeed", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, () => factoryReadinessCheckDependencies.connect("127.0.0.1", tcp.port, 4_000)));
    expect(results.every(Boolean)).toBe(true);
  });

  test("fetchStatus returns the real status and does not follow redirects", async () => {
    const base = `http://127.0.0.1:${http.port}`;
    expect(await factoryReadinessCheckDependencies.fetchStatus(`${base}/ready`, 4_000)).toBe(200);
    expect(await factoryReadinessCheckDependencies.fetchStatus(`${base}/redirect`, 4_000)).toBe(302);
    expect(await factoryReadinessCheckDependencies.fetchStatus(`${base}/other`, 4_000)).toBe(503);
    expect(await factoryReadinessCheck(["--http", `${base}/ready`], factoryReadinessCheckDependencies)).toBe(true);
    expect(await factoryReadinessCheck(["--http", `${base}/redirect`], factoryReadinessCheckDependencies)).toBe(false);
  });
});

describe("startFactoryReadinessCheck", () => {
  const script = "/opt/factory/src/factory/provisioning/readiness-check.ts";
  const moduleUrl = pathToFileURL(script).href;

  test("does nothing when the module is imported rather than run", async () => {
    const { dependencies, calls } = fakes();
    const exits: number[] = [];
    await startFactoryReadinessCheck(["bun"], moduleUrl, (code) => exits.push(code), dependencies);
    await startFactoryReadinessCheck(["bun", "/opt/other.ts", "--tcp", "h:1"], moduleUrl, (code) => exits.push(code), dependencies);
    expect(exits).toEqual([]);
    expect(calls.connect).toEqual([]);
  });

  test("exits 0 when healthy and 1 when not, for the running module", async () => {
    const exits: number[] = [];
    await startFactoryReadinessCheck(["bun", script, "--tcp", "h:1"], moduleUrl, (code) => exits.push(code), fakes().dependencies);
    await startFactoryReadinessCheck(["bun", script, "--tcp", "h:1"], moduleUrl, (code) => exits.push(code), fakes({ connect: async () => false }).dependencies);
    await startFactoryReadinessCheck(["bun", script], moduleUrl, (code) => exits.push(code), fakes().dependencies);
    expect(exits).toEqual([0, 1, 1]);
  });

  test("the default exit is the process's own, with the check's code", async () => {
    const original = process.exit;
    const codes: number[] = [];
    process.exit = ((code?: number) => { codes.push(code ?? -1); }) as typeof process.exit;
    try { await startFactoryReadinessCheck(["bun", script, "--tcp", "h:1"], moduleUrl, undefined, fakes({ connect: async () => false }).dependencies); }
    finally { process.exit = original; }
    expect(codes).toEqual([1]);
  });

  test("matches a relative argv[1] that resolves to the module", async () => {
    const exits: number[] = [];
    const here = join(process.cwd(), "readiness-check.ts");
    await startFactoryReadinessCheck(["bun", "./readiness-check.ts", "--http", "http://x/"], pathToFileURL(here).href, (code) => exits.push(code), fakes().dependencies);
    expect(exits).toEqual([0]);
  });

  test("running the file as the process entry exits 0 for ready and 1 otherwise", async () => {
    const root = await makeFactoryPrivateRoot();
    try {
      const ready = await writeModeFile(join(root, "ready.json"), '{"lifecycle":"ready"}');
      const starting = await writeModeFile(join(root, "starting.json"), '{"lifecycle":"starting"}');
      const run = async (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "readiness-check.ts"), ...args], { stdio: ["ignore", "ignore", "ignore"] }).exited;
      expect(await run(ready)).toBe(0);
      expect(await run(starting)).toBe(1);
      expect(await run("--tcp", "bad")).toBe(1);
    } finally {
      await removeFactoryPrivateRoot(root);
    }
  });

  test("uses the real dependencies by default", async () => {
    const root = await makeFactoryPrivateRoot();
    try {
      const record = await writeModeFile(join(root, "ready.json"), '{"lifecycle":"ready"}');
      const exits: number[] = [];
      await startFactoryReadinessCheck(["bun", script, record], moduleUrl, (code) => exits.push(code));
      expect(exits).toEqual([0]);
    } finally {
      await removeFactoryPrivateRoot(root);
    }
  });
});
