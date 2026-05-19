import { beforeAll, describe, expect, test } from "bun:test";
import { doctor } from "../../src/cli/doctor";
import { E2E_API_KEY, E2E_BASE_URL, e2eReady } from "./_guard";

let ready = false;
beforeAll(async () => {
  ready = await e2eReady();
});

describe.skipIf(!E2E_BASE_URL)("e2e: doctor", () => {
  test("doctor reports ok when server is healthy + key is valid", async () => {
    if (!ready) return;
    const ok = await doctor({ baseUrl: E2E_BASE_URL, apiKey: E2E_API_KEY });
    expect(typeof ok).toBe("boolean");
    if (E2E_API_KEY) expect(ok).toBe(true);
  }, 10_000);

  test("doctor reports failure for unreachable baseUrl", async () => {
    const ok = await doctor({ baseUrl: "http://127.0.0.1:1", apiKey: undefined });
    expect(ok).toBe(false);
  }, 10_000);
});
