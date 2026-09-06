import { beforeAll, describe, expect, test } from "bun:test";
import { doctor } from "../../../../../packages/@ezcorp/ai-kit/src/cli/doctor";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady } from "../../../../../packages/@ezcorp/ai-kit/test/e2e/_guard";

describe.skipIf(!E2E_BASE_URL)("e2e: doctor", () => {
  beforeAll(requireE2eReady);

  test("doctor reports ok when the configured server is healthy", async () => {
    const ok = await doctor({ baseUrl: E2E_BASE_URL, apiKey: E2E_API_KEY });
    expect(ok).toBe(true);
  }, 10_000);

});

test("doctor reports failure for unreachable baseUrl", async () => {
  const ok = await doctor({ baseUrl: "http://127.0.0.1:1", apiKey: undefined });
  expect(ok).toBe(false);
}, 10_000);
