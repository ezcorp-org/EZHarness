import { expect, test } from "bun:test";

/**
 * One source, one trusted SDK bundle, whoever builds it (W4H-28, ruling A+B). Bun inlines the builder's NODE_ENV (and
 * BUN_ENV) into a bundle by default, so the same SDK built under `bun test` and under a service gave two digests, and
 * every artifact that embeds the bundle followed. Each build runs in its own process: provisionToolchain caches per process.
 */
const MARKER = "w4h28-builder-env-marker";
const PROGRAM = `
const { provisionToolchain, filesDigest } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)});
const { sdkFiles } = await provisionToolchain();
const text = Object.values(sdkFiles).join("\\n");
console.log(JSON.stringify({ digest: filesDigest(sdkFiles), marker: text.includes(${JSON.stringify(MARKER)}), runtimeRead: text.includes('process.env.NODE_ENV ?? "test"') }));
`;

async function bundleUnder(nodeEnv: string | undefined): Promise<{ digest: string; marker: boolean; runtimeRead: boolean }> {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: nodeEnv, BUN_ENV: nodeEnv };
  if (nodeEnv === undefined) { delete env.NODE_ENV; delete env.BUN_ENV; }
  const child = Bun.spawn([process.execPath, "-e", PROGRAM], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`bundle process failed (${code}): ${err.slice(0, 2000)}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("the trusted SDK bundle is the same whatever the builder's NODE_ENV, and none of the builder's value reaches it", async () => {
  const [marked, unset, production] = await Promise.all([bundleUnder(MARKER), bundleUnder(undefined), bundleUnder("production")]);
  expect(marked.marker).toBe(false);
  expect(marked.digest).toBe(unset.digest);
  expect(production.digest).toBe(unset.digest);
  // The SDK's own runtime read stays a runtime read in the guest.
  expect(unset.runtimeRead).toBe(true);
}, 180_000);

test("in this process too, the bundle keeps the runtime read and carries none of this builder's NODE_ENV", async () => {
  const { provisionToolchain } = await import("../src/index.ts");
  const text = Object.values((await provisionToolchain()).sdkFiles).join("\n");
  expect(text).toContain('process.env.NODE_ENV ?? "test"');
  expect(text).not.toContain(`NODE_ENV: ${JSON.stringify(process.env.NODE_ENV)}`);
});
