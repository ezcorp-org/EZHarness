import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PASS_PROCESSES,
  PASS_READINESS_FILES,
  binaryForms,
  checkPassDiagnostics,
  collectSecretValues,
  openProcessLog,
  preserveStackDiagnostics,
  jsonStringLeaves,
  processLogPath,
  redactStreamedLogs,
  stackCopyDir,
} from "../../scripts/factory-graph-proof/diagnostics";
import { graphReferences, graphRunnerProfiles, modePin } from "../../scripts/factory-graph-proof/graph";
import { orchestratorDocument, poolDatabaseDocument, poolDocument, startupDocument, supervisorDocument, wrapsDocument, type StackLayout } from "../../scripts/factory-graph-proof/stack-documents";

/**
 * What a graph-proof pass leaves behind, proved on real files.
 *
 * The W19a merge batch lost a failed pass's diagnostics because process output
 * lived only in memory and the stack directory was deleted. These cases pin the
 * replacement: output streams to disk with a header and an exit line, a failed
 * pass carries its readiness files out, and nothing that leaves carries a
 * secret the stack holds.
 */

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "w19b-diagnostics-"));
  directories.push(path);
  return path;
}

const clock = () => new Date("2026-09-25T10:00:00.000Z");

describe("a process's streamed log", () => {
  test("carries a header, every byte the process wrote, and an exit line, even when the process printed nothing", async () => {
    const dir = await scratch();
    const diagnostics = { dir, label: "pass-1" };
    const speaking = openProcessLog(diagnostics, "web", "bun", ["build/index.js"], 4242, clock);
    speaking.write("listening\n");
    speaking.write(Buffer.from("ready\n"));
    await speaking.close({ code: 0, signal: null });
    expect(await readFile(processLogPath(diagnostics, "web"), "utf8")).toBe(
      "[w19-harness] web started 2026-09-25T10:00:00.000Z pid 4242: bun build/index.js\nlistening\nready\n[w19-harness] web exited 2026-09-25T10:00:00.000Z code 0 signal none\n",
    );
    const silent = openProcessLog(diagnostics, "pool", "bun", ["pool.ts"], undefined, clock);
    await silent.close({ code: null, signal: "SIGKILL" });
    expect(await readFile(silent.path, "utf8")).toBe("[w19-harness] pool started 2026-09-25T10:00:00.000Z pid unknown: bun pool.ts\n[w19-harness] pool exited 2026-09-25T10:00:00.000Z code none signal SIGKILL\n");
  });

  test("stamps the real time when no clock is given", async () => {
    const log = openProcessLog({ dir: await scratch(), label: "pass-clock" }, "orchestrator", "bash", ["runner.sh"], 9);
    await log.close({ code: 0, signal: null });
    expect(await readFile(log.path, "utf8")).toMatch(/^\[w19-harness\] orchestrator started \d{4}-\d\d-\d\dT[^ ]+Z pid 9: bash runner\.sh\n\[w19-harness\] orchestrator exited \d{4}-\d\d-\d\dT[^ ]+Z code 0 signal none\n$/);
  });

  test("closes once: a second close and a late write change nothing", async () => {
    const dir = await scratch();
    const log = openProcessLog({ dir, label: "pass-2" }, "supervisor", "bun", [], 1, clock);
    const first = log.close({ code: 1, signal: null });
    const second = log.close({ code: null, signal: "harness-stopped" });
    expect(second).toBe(first);
    await first;
    log.write("after the exit\n");
    const text = await readFile(log.path, "utf8");
    expect(text.endsWith("[w19-harness] supervisor exited 2026-09-25T10:00:00.000Z code 1 signal none\n")).toBe(true);
    expect(text).not.toContain("after the exit");
    expect(text).not.toContain("harness-stopped");
  });
});

describe("the secrets a stack holds", () => {
  test("are each text file's content, each non-configuration string inside a JSON file, and each URL password, longest first", async () => {
    const secrets = await scratch();
    await writeFile(join(secrets, "tenant.token"), "eyJhbGciOiJSUzI1NiJ9.tenant-token-body.signature\n");
    await writeFile(join(secrets, "pool-database.json"), JSON.stringify({ databaseUrl: "postgres://proof:s3cret-password-value@127.0.0.1:5432/w19a_pool" }));
    await writeFile(join(secrets, "ordinary-storage.json"), JSON.stringify({ identities: [{ credentials: [{ accessKey: "ACCESSKEY0123456", secretKey: "secret-key-0123456789", note: "short" }] }] }));
    await writeFile(join(secrets, "host.kid"), "host-key-1");
    // A process's configuration document is not a credential: its ids, namespaces and paths stay out.
    await writeFile(join(secrets, "supervisor.json"), JSON.stringify({ installationId: "installation-w19a", temporalNamespace: "tenant-01.factory", services: { serviceTokenPath: "/home/dev/.w19a-stack-x/secrets/tenant.token", tls: { privateKeyPath: "/home/dev/.w19a-stack-x/secrets/client.key" } }, apiKey: "temporal-api-key-value" }));
    await writeFile(join(secrets, "huge.bin"), Buffer.alloc(64 * 1024 + 1, 97));
    await mkdir(join(secrets, "nested"));
    const values = await collectSecretValues(secrets, ["w19a-jwt-0123456789abcdef", "tiny"]);
    for (const value of ["eyJhbGciOiJSUzI1NiJ9.tenant-token-body.signature", "postgres://proof:s3cret-password-value@127.0.0.1:5432/w19a_pool", "s3cret-password-value", "ACCESSKEY0123456", "secret-key-0123456789", "w19a-jwt-0123456789abcdef"]) {
      expect(values).toContain(value);
    }
    // Too short to be a credential, a file too large to be one, and a directory: none is a value.
    for (const value of ["host-key-1", "tiny", "short", "installation-w19a", "tenant-01.factory", "/home/dev/.w19a-stack-x/secrets/tenant.token", "/home/dev/.w19a-stack-x/secrets/client.key"]) expect(values).not.toContain(value);
    expect(values).toContain("temporal-api-key-value");
    expect(values.some((value) => value.startsWith("aaaa"))).toBe(false);
    expect([...values].sort((left, right) => right.length - left.length)).toEqual(values);
  });

  test("with no secrets directory, are the extra values alone", async () => {
    expect(await collectSecretValues(join(await scratch(), "absent"), ["only-in-the-environment-1"])).toEqual(["only-in-the-environment-1"]);
  });

  test("are redacted from a streamed log wherever they appear, and each redaction is counted", async () => {
    const dir = await scratch();
    const leaky = join(dir, "leaky.log");
    const clean = join(dir, "clean.log");
    await writeFile(leaky, "token eyJhbGciOiJSUzI1NiJ9.body.sig and the password s3cret-password-value twice: s3cret-password-value\n");
    await writeFile(clean, "nothing to hide\n");
    const counts = redactStreamedLogs([leaky, clean, join(dir, "gone.log")], ["eyJhbGciOiJSUzI1NiJ9.body.sig", "s3cret-password-value"]);
    expect(counts).toEqual({ [leaky]: 3 });
    expect(await readFile(leaky, "utf8")).toBe("token [redacted] and the password [redacted] twice: [redacted]\n");
    expect(await readFile(clean, "utf8")).toBe("nothing to hide\n");
  });
});

describe("every JSON document the stack writes under secrets/", () => {
  /** The keys whose values are credentials. Every other string must be configuration. */
  const SECRET_KEYS = new Set(["databaseUrl", "wrappedDataKey", "accessKey", "secretKey"]);
  const guest = { package: "@ezcorp/w19a-graph-guest", manifestName: "w19a-graph-guest", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
  const layout = (mode: "mock" | "ollama" | "none"): StackLayout => {
    const pin = mode === "none" ? undefined : modePin(mode);
    return {
      root: "/home/proof/.w19a-stack-abcdef",
      poolDatabase: "w19a_pool_0123456789",
      poolUrl: "postgres://w19a-proof-role:pool-password-0123456789@127.0.0.1:5432/w19a_pool_0123456789",
      ports: { pool: 41001, hostService: 41002, guestBroker: 41003, temporalTls: 41004, temporalHttp: 41005, gateway: 41006, privateService: 41007 },
      runnerProfiles: graphRunnerProfiles(graphReferences(guest, pin), pin),
      ...(pin === undefined ? {} : { modelProvider: { provider: pin.provider, model: pin.model } }),
    };
  };
  /** Each file by the name stack.ts gives it. The storage files are copies of the shared store's, in its shape. */
  const documents = (mode: "mock" | "ollama" | "none"): Record<string, unknown> => ({
    "pool-database.json": poolDatabaseDocument(layout(mode).poolUrl),
    "wraps.json": wrapsDocument([{ installationId: "installation-w19a", wrapVersion: 1, masterKeyId: "master-1", wrappedDataKey: randomBytes(60) }]),
    "pool.json": poolDocument(layout(mode)),
    "supervisor.json": supervisorDocument(layout(mode)),
    "factory-startup.json": startupDocument(layout(mode)),
    "orchestrator.json": orchestratorDocument(layout(mode)),
    "ordinary-storage.json": { identities: [{ name: "ordinary-identity", actions: ["Read", "Write", "List"], credentials: [{ accessKey: "ORDINARYACCESS0123", secretKey: "ordinary-secret-key-0123456789" }] }] },
  });

  test("has each string judged a secret exactly when its key is a credential key, so a new field fails here until it is classified", async () => {
    for (const mode of ["mock", "ollama", "none"] as const) {
      for (const [file, document] of Object.entries(documents(mode))) {
        const leaves = jsonStringLeaves(JSON.parse(JSON.stringify(document)));
        expect(leaves.length).toBeGreaterThan(0);
        for (const leaf of leaves) expect({ file, at: leaf.at, secret: leaf.secret }).toEqual({ file, at: leaf.at, secret: SECRET_KEYS.has(leaf.key ?? "") });
      }
    }
  });

  /**
   * What each `privateWrite(...)` call in a source serializes: the name of the
   * builder (or variable) handed to `JSON.stringify`, or `"inline"` for
   * anything else, such as an object literal. Each call is read whole, however
   * many lines it spans.
   */
  function writtenDocuments(source: string): string[] {
    const found: string[] = [];
    for (let at = source.indexOf("privateWrite("); at !== -1; at = source.indexOf("privateWrite(", at + 1)) {
      let depth = 0;
      let end = at + "privateWrite".length;
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")" && --depth === 0) break;
      }
      const call = source.slice(at, end + 1);
      for (const match of call.matchAll(/JSON\.stringify\(\s*/g)) {
        found.push(/^([A-Za-z_$][\w$]*)\s*[()]/.exec(call.slice(match.index + match[0].length))?.[1] ?? "inline");
      }
    }
    return found.sort();
  }

  test("is every document stack.ts writes: an inline JSON document there fails this test", async () => {
    const source = await readFile(join(import.meta.dir, "../../scripts/factory-graph-proof/stack.ts"), "utf8");
    expect(writtenDocuments(source)).toStrictEqual(["orchestratorDocument", "poolDatabaseDocument", "poolDocument", "startup", "supervisorDocument", "wrapsDocument"]);
    expect(source).toContain("const startup = startupDocument(layout);");
  });

  test("has a guard that sees an inline document on one line or split across lines", () => {
    const builder = `await privateWrite(join(secrets, "pool.json"), JSON.stringify(poolDocument(layout)));`;
    expect(writtenDocuments(builder)).toStrictEqual(["poolDocument"]);
    expect(writtenDocuments(`${builder}\nawait privateWrite(join(secrets, "probe.json"), JSON.stringify({ probeToken: "x" }));`)).toStrictEqual(["inline", "poolDocument"]);
    expect(writtenDocuments(`${builder}\nawait privateWrite(\n  join(secrets, "probe.json"),\n  JSON.stringify(\n    { probeToken: "x" },\n  ),\n);`)).toStrictEqual(["inline", "poolDocument"]);
    expect(writtenDocuments(`await privateWrite(path, JSON.stringify(\n  document.field));`)).toStrictEqual(["inline"]);
    expect(writtenDocuments(`await privateWrite(path, "plain text");`)).toStrictEqual([]);
  });

  test("gives up a URL's password even under a configuration key, and it is refused and redacted", async () => {
    const root = await scratch();
    await mkdir(join(root, "secrets"));
    await mkdir(join(root, "readiness"));
    const password = "url-password-0123456789";
    await writeFile(join(root, "secrets", "service.json"), JSON.stringify({ baseUrl: `https://proof:${password}@127.0.0.1:9000/`, endpoint: "http://127.0.0.1:18333", hostname: "127.0.0.1" }));
    const values = await collectSecretValues(join(root, "secrets"));
    expect(values).toStrictEqual([password]);
    await writeFile(join(root, "readiness", "pool.json"), JSON.stringify({ lifecycle: "degraded", detail: `login failed for ${password}` }));
    const preserved = await preserveStackDiagnostics(root, { dir: await scratch(), label: "url" }, values);
    expect(preserved.refused).toStrictEqual(["readiness/pool.json"]);
    const log = join(await scratch(), "url.log");
    await writeFile(log, `connecting as proof:${password}\n`);
    expect(redactStreamedLogs([log], values)).toStrictEqual({ [log]: 1 });
    expect(await readFile(log, "utf8")).toBe("connecting as proof:[redacted]\n");
  });

  test("yields its credentials to the collection and nothing else", async () => {
    const secrets = await scratch();
    const files = documents("mock");
    for (const [file, document] of Object.entries(files)) await writeFile(join(secrets, file), JSON.stringify(document));
    const values = await collectSecretValues(secrets);
    const leaves = Object.values(files).flatMap((document) => jsonStringLeaves(JSON.parse(JSON.stringify(document))));
    for (const leaf of leaves.filter((entry) => entry.value.length >= 12)) expect({ at: leaf.at, collected: values.includes(leaf.value) }).toEqual({ at: leaf.at, collected: leaf.secret });
    expect(values).toContain("pool-password-0123456789");
  });

  test("fails closed: an unknown field, a bare string, and a string under a data-keyed object are secrets", () => {
    const leaves = jsonStringLeaves({ serviceToken: "a", privateKey: "b", clientSecret: "c", tenants: { "tenant-a": "d" }, hosts: { subject: "host-1" }, publicKeyPaths: { proof: "/p" }, keyPath: "/k" });
    expect(Object.fromEntries(leaves.map((leaf) => [leaf.at, leaf.secret]))).toEqual({
      "$.serviceToken": true, "$.privateKey": true, "$.clientSecret": true, "$.tenants.tenant-a": true,
      "$.hosts.subject": false, "$.publicKeyPaths.proof": false, "$.keyPath": false,
    });
    expect(jsonStringLeaves("a-bare-json-string")).toEqual([{ at: "$", key: undefined, value: "a-bare-json-string", secret: true }]);
  });
});

describe("a binary secret file", () => {
  test("yields its hex and base64 forms, and each form planted in a stack file is refused and redacted", async () => {
    const root = await scratch();
    await mkdir(join(root, "secrets"));
    await mkdir(join(root, "readiness"));
    // 32 random bytes with a NUL, as secrets/master.key is: never valid text.
    const key = Buffer.concat([Buffer.from([0]), randomBytes(31)]);
    await writeFile(join(root, "secrets", "master.key"), key);
    const values = await collectSecretValues(join(root, "secrets"));
    const forms = binaryForms(key);
    expect(forms).toEqual([key.toString("hex"), key.toString("hex").toUpperCase(), key.toString("base64"), key.toString("base64").replace(/=+$/, ""), key.toString("base64url")]);
    for (const form of forms) expect(values).toContain(form);
    for (const [index, form] of forms.entries()) await writeFile(join(root, "readiness", `planted-${index}.json`), JSON.stringify({ lifecycle: "ready", masterKey: form }));
    await writeFile(join(root, "readiness", "clean.json"), JSON.stringify({ lifecycle: "ready" }));
    const preserved = await preserveStackDiagnostics(root, { dir: await scratch(), label: "binary" }, values);
    expect(preserved.copied).toEqual(["readiness/clean.json"]);
    expect([...preserved.refused].sort()).toEqual(forms.map((_, index) => `readiness/planted-${index}.json`));
    const log = join(await scratch(), "printed.log");
    await writeFile(log, `${forms.join("\n")}\n`);
    redactStreamedLogs([log], values);
    expect(await readFile(log, "utf8")).toBe(`${forms.map(() => "[redacted]").join("\n")}\n`);
  });

  test("is told from text by valid UTF-8 and no control byte other than tab, line feed and carriage return", async () => {
    const secrets = await scratch();
    const files: Record<string, Buffer> = {
      "text.pem": Buffer.from("-----BEGIN KEY-----\r\n\tline-of-text-é\n"),
      "invalid-utf8.key": Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a]),
      "delete-byte.key": Buffer.from("abcdefghijkl\x7fmnop", "latin1"),
      "control-byte.key": Buffer.from("abcdefghijkl\x01mnop", "latin1"),
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(secrets, name), bytes);
    const values = await collectSecretValues(secrets);
    expect(values).toContain("-----BEGIN KEY-----\r\n\tline-of-text-é");
    for (const name of ["invalid-utf8.key", "delete-byte.key", "control-byte.key"]) {
      for (const form of binaryForms(files[name]!)) expect(values).toContain(form);
    }
  });
});

describe("redaction while a process runs", () => {
  test("rewrites the log between two chunks without losing a byte, and counts only what it replaced", async () => {
    const dir = await scratch();
    const log = openProcessLog({ dir, label: "live" }, "pool", "bun", ["pool.ts"], 5, clock);
    log.write("first line carries live-secret-0123456789\n");
    expect(redactStreamedLogs([log.path], ["live-secret-0123456789"])).toEqual({ [log.path]: 1 });
    log.write("second line is plain\n");
    expect(redactStreamedLogs([log.path], ["live-secret-0123456789"])).toEqual({});
    await log.close({ code: 0, signal: null });
    expect(await readFile(log.path, "utf8")).toBe(
      "[w19-harness] pool started 2026-09-25T10:00:00.000Z pid 5: bun pool.ts\nfirst line carries [redacted]\nsecond line is plain\n[w19-harness] pool exited 2026-09-25T10:00:00.000Z code 0 signal none\n",
    );
  });
});

describe("a failed pass's stack", () => {
  async function stack() {
    const root = await scratch();
    for (const directory of ["secrets", "readiness", "runner/store", "runner/locked"]) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, "secrets", "tenant.token"), "the-tenant-token-value");
    await writeFile(join(root, "secrets", "extra.log"), "a log inside secrets never leaves");
    await writeFile(join(root, "readiness", "pool.json"), JSON.stringify({ lifecycle: "degraded", errorCode: "pool_database_unavailable" }));
    await writeFile(join(root, "readiness", "supervisor.json"), JSON.stringify({ lifecycle: "ready" }));
    await writeFile(join(root, "readiness", "orchestration.json"), JSON.stringify({ lifecycle: "ready", note: "the-tenant-token-value" }));
    await writeFile(join(root, "runner", "store", "build.log"), "built\n");
    await writeFile(join(root, "runner", "store", "huge.log"), Buffer.alloc(5 * 1024 * 1024 + 1, 98));
    await writeFile(join(root, "temporal.sqlite"), "not a diagnostic");
    return root;
  }

  test("carries its readiness files and logs out, refuses a file that holds a secret, and never touches secrets/", async () => {
    const root = await stack();
    await chmod(join(root, "runner", "locked"), 0o000);
    const out = await scratch();
    const diagnostics = { dir: out, label: "failed-pass" };
    try {
      const preserved = await preserveStackDiagnostics(root, diagnostics, ["the-tenant-token-value"]);
      expect([...preserved.copied].sort()).toEqual(["readiness/pool.json", "readiness/supervisor.json", "runner/store/build.log"]);
      expect(preserved.refused).toEqual(["readiness/orchestration.json"]);
      expect(preserved.oversize).toEqual({ "runner/store/huge.log": 5 * 1024 * 1024 + 1 });
      expect(preserved.unreadable).toEqual(["runner/locked"]);
      expect(JSON.parse(await readFile(join(stackCopyDir(diagnostics), "readiness", "pool.json"), "utf8"))).toEqual({ lifecycle: "degraded", errorCode: "pool_database_unavailable" });
      await expect(readFile(join(stackCopyDir(diagnostics), "secrets", "extra.log"), "utf8")).rejects.toThrow();
      await expect(readFile(join(stackCopyDir(diagnostics), "temporal.sqlite"), "utf8")).rejects.toThrow();
    } finally {
      await chmod(join(root, "runner", "locked"), 0o700);
    }
  });

  test("is judged from the files alone: every process log with its exit line, every readiness file", async () => {
    const out = await scratch();
    const diagnostics = { dir: out, label: "forced" };
    const empty = await checkPassDiagnostics(diagnostics);
    expect(empty.ok).toBe(false);
    expect(empty.problems).toEqual([...PASS_PROCESSES.map((name) => `process log ${name} is missing`), ...PASS_READINESS_FILES.map((name) => `stack file ${name} is missing`)]);

    for (const name of PASS_PROCESSES) {
      const log = openProcessLog(diagnostics, name, "bun", [name], 7, clock);
      await log.close({ code: 0, signal: null });
    }
    for (const name of PASS_READINESS_FILES) {
      await mkdir(join(stackCopyDir(diagnostics), "readiness"), { recursive: true });
      await writeFile(join(stackCopyDir(diagnostics), name), "{\"lifecycle\":\"ready\"}");
    }
    const whole = await checkPassDiagnostics(diagnostics);
    expect(whole).toMatchObject({ ok: true, problems: [] });
    expect(whole.processLogs.pool).toMatchObject({ exitLine: true });

    // A log cut off before its exit line, an empty log, and an empty readiness file are each named.
    await writeFile(processLogPath(diagnostics, "pool"), "[w19-harness] pool started\n");
    await writeFile(processLogPath(diagnostics, "web"), "");
    await writeFile(join(stackCopyDir(diagnostics), "readiness/supervisor.json"), "");
    expect((await checkPassDiagnostics(diagnostics)).problems).toEqual(["process log pool has no exit line", "process log web is empty", "stack file readiness/supervisor.json is empty"]);
  });
});
