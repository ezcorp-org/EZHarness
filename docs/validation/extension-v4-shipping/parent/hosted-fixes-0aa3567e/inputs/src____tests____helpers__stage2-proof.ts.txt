import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
export const stage2Enabled = process.env.EZCORP_STAGE2_PROOF === "1";
export type Stage2Mode = "--nft-on" | "--nft-off" | "--ipv6-on" | "--ipv6-off";
export interface Stage2Receipt {
  childPid: number;
  sourceSha256: string;
  rawConnect: string | null;
  ipv6: null | {
    eth0Disable: string;
    loDisable: string;
    eth0HasSeed: boolean;
    loHasSeed: boolean;
    routeExit: number;
    routeStderr: string;
    routeStdout: string;
  };
  acceptedConnections: number;
  openConnections: number;
  faultDisableCommandsRemoved: string[];
}

if (!stage2Enabled) console.warn("[stage2-proof] SKIPPING: set EZCORP_STAGE2_PROOF=1 and EZCORP_STAGE2_PROOF_IMAGE in the candidate-image lane");

export function runStage2Proof(mode: Stage2Mode, expectedExit: number, expectedFailure?: string): Stage2Receipt {
  const result = Bun.spawnSync({
    cmd: ["bash", resolve(root, "scripts/stage2-raw-network-proof.sh"), mode],
    cwd: root, env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  expect(result.exitCode, stdout + "\n" + stderr).toBe(expectedExit);
  if (expectedFailure) expect(stderr).toContain(expectedFailure);
  else expect(stderr).toBe("");
  const receipt = JSON.parse(stdout) as Stage2Receipt;
  expect(receipt).toMatchObject({
    mode, launcher: "/app/src/extensions/mcp-launcher.sh",
    sourceSha256: createHash("sha256").update(readFileSync(resolve(root, "src/extensions/mcp-launcher.sh"))).digest("hex"),
    childPid: expect.any(Number), childExit: 0, childSignal: null,
    proxy: {
      wrong: { status: "HTTP/1.1 407 Proxy Authentication Required" },
      denied: { status: "HTTP/1.1 403 Forbidden" },
      allowed: { status: "HTTP/1.1 200 Connection Established", output: "stage2-owned-proxy-output" },
    },
    upstreamConnections: 1, policyHosts: ["93.184.216.35", "93.184.216.34"],
    openConnections: 0, stderr: "",
  });
  return receipt;
}
