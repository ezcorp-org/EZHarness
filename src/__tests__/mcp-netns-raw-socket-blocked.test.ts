/**
 * Stage 2 raw TCP proof against the production launcher.
 *
 * A private, owned Podman container runs the launcher with an owned veth pair.
 * A listener on its forbidden peer address (10.42.0.2) is reachable when nft
 * is removed. With the launcher-installed nft policy present, the same direct
 * TCP connect must end at its bounded socket timeout. This proves a real deny;
 * it does not confuse an old scaffold's ENETUNREACH route expectation with a
 * policy drop.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const driver = resolve(root, "scripts/stage2-raw-network-proof.sh");
const launcher = resolve(root, "src/extensions/mcp-launcher.sh");
const image = "localhost/ezcorp-extension-v4:terra-final-26541024";

function runProof(mode: "--nft-on" | "--nft-off") {
  return Bun.spawnSync({
    cmd: ["bash", driver, mode],
    cwd: root,
    env: {
      ...process.env,
      CONMON: "/tmp/ez-audit-ci-conmon",
      EZCORP_STAGE2_PROOF_IMAGE: image,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function receipt(result: ReturnType<typeof runProof>) {
  const stdout = new TextDecoder().decode(result.stdout).trim();
  return JSON.parse(stdout) as {
    mode: string;
    launcher: string;
    sourceSha256: string;
    listener: string;
    childExit: number;
    rawConnect: string;
    stderr: string;
  };
}

describe("RC#1: Stage 2 blocks direct raw TCP", () => {
  test(
    "production launcher drops raw TCP, while deleting only nft makes the required deny assertion fail",
    () => {
      const expectedSourceSha256 = createHash("sha256")
        .update(readFileSync(launcher))
        .digest("hex");

      const nftOn = runProof("--nft-on");
      const nftOnReceipt = receipt(nftOn);
      expect(nftOn.exitCode).toBe(0);
      expect(nftOnReceipt).toEqual({
        mode: "--nft-on",
        launcher: "/app/src/extensions/mcp-launcher.sh",
        sourceSha256: expectedSourceSha256,
        listener: "10.42.0.2:45873",
        childExit: 0,
        rawConnect: "TIMEOUT",
        stderr: "",
      });

      const nftOff = runProof("--nft-off");
      const nftOffReceipt = receipt(nftOff);
      const nftOffStderr = new TextDecoder().decode(nftOff.stderr);
      expect(nftOff.exitCode).toBe(41);
      expect(nftOffReceipt).toEqual({
        ...nftOnReceipt,
        mode: "--nft-off",
        rawConnect: "CONNECTED",
      });
      expect(nftOffStderr).toContain("DENY_ASSERTION_FAILED: forbidden raw TCP connected");
    },
    30_000,
  );
});
