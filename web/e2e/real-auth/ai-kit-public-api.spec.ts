import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, expect } from "../fixtures/hydration.js";

const runFile = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Reuse the package's public contracts against the real-auth server. Running
// Bun in a separate process keeps its test mocks and database globals isolated.
async function runPackageSuites(files: string[], env: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
  const { stdout: runtimeVersion } = await runFile("bun", ["--version"]);
  expect(runtimeVersion.trim()).toBe((await readFile(join(projectRoot, ".bun-version"), "utf8")).trim());
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ezh-kit-"));
  try {
    const { stdout, stderr } = await runFile(
      "bun",
      ["test", "--timeout", "30000", ...files.map((file) => `./packages/@ezcorp/ai-kit/test/e2e/${file}.test.ts`)],
      {
        cwd: projectRoot,
        env: { ...process.env, ...env, TMPDIR: temporaryRoot },
        timeout,
        maxBuffer: 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("AI-kit public client authenticates and rejects forged authority over HTTP", async ({ request, baseURL }) => {
  test.setTimeout(90_000);
  expect(baseURL).toBeTruthy();
  const minted = await request.post("/api/settings/developer/api-keys", {
    data: { name: "e2e-ai-kit-public", scopes: ["read", "chat"] },
  });
  expect(minted.status()).toBe(201);
  const { key, keyId } = (await minted.json()) as { key: string; keyId: string };
  try {
    const output = await runPackageSuites(["doctor", "internal-auth", "on-behalf-of"], {
      EZCORP_E2E_BASE_URL: baseURL,
      EZCORP_E2E_API_KEY: key,
    });
    expect(output).toMatch(/\b7 pass\b/);
    expect(output).not.toMatch(/\(skip\)|[1-9]\d* skip/);
  } finally {
    const revoked = await request.delete("/api/settings/developer/api-keys", { data: { keyId } });
    expect(revoked.status()).toBe(204);
  }
});

test("AI-kit deployed-service suites run here and skip by name what this lane cannot provide yet", async ({ request, baseURL }) => {
  // These three package suites select themselves from the URL and key; no other lane sets them (W4H-33).
  test.setTimeout(150_000);
  expect(baseURL).toBeTruthy();
  const minted = await request.post("/api/settings/developer/api-keys", {
    data: { name: "e2e-ai-kit-deployed", scopes: ["read", "chat"] },
  });
  expect(minted.status()).toBe(201);
  const { key, keyId } = (await minted.json()) as { key: string; keyId: string };
  try {
    const output = await runPackageSuites(["bundled", "quickstart", "fanout"], {
      EZCORP_E2E_BASE_URL: baseURL,
      EZCORP_E2E_API_KEY: key,
    }, 130_000);
    // This lane does not yet install ai-kit, pin the mock model or seed the fan-out agents and team (leftover
    // ai-kit-deployed-lane, scripts/test-skip-registry.json). Until it does, each missing precondition skips by its tracked name, nothing fails, and
    // spawn_chats, which needs nothing seeded, passes.
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).toMatch(/\b1 pass\b/);
    for (const precondition of ["ai-kit installed", "EZCORP_E2E_MODEL", "agents researcher and writer", "autoSpinUp team", "an agent"]) {
      expect(output).toContain(`skip: precondition ${precondition} missing; tracked: ai-kit-deployed-lane`);
    }
  } finally {
    const revoked = await request.delete("/api/settings/developer/api-keys", { data: { keyId } });
    expect(revoked.status()).toBe(204);
  }
});

test("AI-kit real stdio subprocess preserves the on-behalf-of ownership chain", async () => {
  test.setTimeout(90_000);
  const output = await runPackageSuites(["real-subprocess-obo"], { EZCORP_E2E_SUBPROCESS: "1" });
  expect(output).toMatch(/\b4 pass\b/);
  expect(output).not.toMatch(/\(skip\)|[1-9]\d* skip/);
});
