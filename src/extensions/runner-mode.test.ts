import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  getExtensionRunnerMode,
  ISOLATED_PROFILE,
  isTrustedLocalMode,
  RUNNER_MODE_VARIABLE,
  TRUSTED_LOCAL_PROFILE,
  trustedLocalBunDigest,
  UNSANDBOXED_ACK_SENTENCE,
  UNSANDBOXED_ACK_VARIABLE,
} from "./runner-mode";

/**
 * The two-key, fail-closed gate. Every branch is a distinct refusal with its
 * own message naming the fix, because an operator reads this once, at boot,
 * from a log line — it has to be enough on its own. Pure: the env is passed
 * in, so nothing here mutates `process.env` or depends on the pool's.
 */
const ON = { [RUNNER_MODE_VARIABLE]: "trusted-local", [UNSANDBOXED_ACK_VARIABLE]: UNSANDBOXED_ACK_SENTENCE };

function refusal(env: Record<string, string | undefined>): string {
  try {
    getExtensionRunnerMode(env);
  } catch (error) {
    expect(error).toMatchObject({ code: "runner_mode_invalid" });
    return (error as Error).message;
  }
  throw new Error("expected the gate to refuse");
}

describe("getExtensionRunnerMode — isolated is the default and the only silent answer", () => {
  test("unset, empty, and the explicit word all mean isolated", () => {
    expect(getExtensionRunnerMode({})).toBe("isolated");
    expect(getExtensionRunnerMode({ [RUNNER_MODE_VARIABLE]: "" })).toBe("isolated");
    expect(getExtensionRunnerMode({ [RUNNER_MODE_VARIABLE]: "isolated" })).toBe("isolated");
    expect(isTrustedLocalMode({})).toBe(false);
  });

  test("the isolated socket settings alone never change the mode", () => {
    expect(getExtensionRunnerMode({ EZCORP_EXTENSION_RUNNER_SOCKET: "/run/x.sock", EZCORP_EXTENSION_RUNNER_TOKEN: "a".repeat(32) })).toBe("isolated");
  });
});

describe("getExtensionRunnerMode — every incoherent combination refuses", () => {
  test("an unknown mode word", () => {
    expect(refusal({ [RUNNER_MODE_VARIABLE]: "unsandboxed" })).toContain('"trusted-local"');
    // Case matters: the mode word is exact, like the acknowledgement.
    expect(refusal({ [RUNNER_MODE_VARIABLE]: "Trusted-Local" })).toContain(RUNNER_MODE_VARIABLE);
  });

  test("a stray acknowledgement while the mode is off — config and intent disagree", () => {
    const message = refusal({ [UNSANDBOXED_ACK_VARIABLE]: UNSANDBOXED_ACK_SENTENCE });
    expect(message).toContain(UNSANDBOXED_ACK_VARIABLE);
    expect(message).toContain(RUNNER_MODE_VARIABLE);
    expect(refusal({ [RUNNER_MODE_VARIABLE]: "isolated", [UNSANDBOXED_ACK_VARIABLE]: "anything" })).toContain(UNSANDBOXED_ACK_VARIABLE);
  });

  test("trusted-local without the acknowledgement names the exact sentence to set", () => {
    const message = refusal({ [RUNNER_MODE_VARIABLE]: "trusted-local" });
    expect(message).toContain(`${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`);
    expect(message).toContain("WITHOUT a sandbox");
  });

  test("trusted-local with a near-miss acknowledgement is still refused — the sentence is exact", () => {
    for (const ack of ["1", "true", "yes", UNSANDBOXED_ACK_SENTENCE.toLowerCase(), `${UNSANDBOXED_ACK_SENTENCE} `, UNSANDBOXED_ACK_SENTENCE.slice(0, -1)]) {
      expect(refusal({ [RUNNER_MODE_VARIABLE]: "trusted-local", [UNSANDBOXED_ACK_VARIABLE]: ack })).toContain(UNSANDBOXED_ACK_SENTENCE);
    }
  });

  test("trusted-local alongside any isolated-runner setting is a conflict, and the message names which", () => {
    expect(refusal({ ...ON, EZCORP_EXTENSION_RUNNER_SOCKET: "/run/x.sock" })).toContain("EZCORP_EXTENSION_RUNNER_SOCKET");
    expect(refusal({ ...ON, EZCORP_EXTENSION_RUNNER_TOKEN: "a".repeat(32) })).toContain("EZCORP_EXTENSION_RUNNER_TOKEN");
    const both = refusal({ ...ON, EZCORP_EXTENSION_RUNNER_TOKEN_FILE: "/run/secrets/t", EZCORP_EXTENSION_RUNNER_SOCKET: "/run/x.sock" });
    expect(both).toContain("EZCORP_EXTENSION_RUNNER_SOCKET");
    expect(both).toContain("EZCORP_EXTENSION_RUNNER_TOKEN_FILE");
  });
});

describe("getExtensionRunnerMode — both keys, coherent", () => {
  test("selects trusted-local", () => {
    expect(getExtensionRunnerMode(ON)).toBe("trusted-local");
    expect(isTrustedLocalMode(ON)).toBe(true);
  });

  test("NODE_ENV=production does not close this gate — self-hosters in production are the audience", () => {
    expect(getExtensionRunnerMode({ ...ON, NODE_ENV: "production" })).toBe("trusted-local");
  });
});

describe("profiles", () => {
  test("the two profiles differ, so switching modes stales every existing approval", () => {
    expect(ISOLATED_PROFILE).toBe("rootless-podman-v4");
    expect(TRUSTED_LOCAL_PROFILE).toBe("trusted-local-v4");
    expect(TRUSTED_LOCAL_PROFILE).not.toBe(ISOLATED_PROFILE);
  });
});

describe("trustedLocalBunDigest", () => {
  test("is the SHA-256 of the running bun binary, and memoised", async () => {
    const first = trustedLocalBunDigest();
    expect(trustedLocalBunDigest()).toBe(first);
    const digest = await first;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(createHash("sha256").update(readFileSync(process.execPath)).digest("hex"));
  });
});
