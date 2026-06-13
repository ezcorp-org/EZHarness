/**
 * Phase A1 Landlock containment self-test (evidence script, NOT a unit test).
 *
 * Proves, end-to-end, that a Landlock fs-jail applied to THIS process:
 *   (a) lets it read an allowed workspace file,
 *   (b) DENIES reading a "secret" file outside the allowlist (EACCES),
 *   (c) reports the resolved sandbox tier from the capability probe.
 *
 * Runs identically on the host and inside the app container (the gate is
 * that the container's seccomp profile permits syscalls 444/445/446 and the
 * kernel has the Landlock LSM active). Run with:
 *
 *   bun src/extensions/sandbox/__spikes__/landlock-selftest.ts
 *
 * Exit code 0 = containment PROVEN (GO). Non-zero = NOT contained — read
 * the printed reason. Output is a single JSON line + human summary so the
 * orchestrator can capture it as gate evidence.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeSandboxCapabilities,
} from "../capability-probe";
import { applyReadOnlyJail, landlockAbiVersion } from "../landlock-ffi";

interface Result {
  arch: string;
  landlockAbi: number;
  tier: string;
  allowedReadOk: boolean;
  deniedReadBlocked: boolean;
  deniedErrno: string | null;
  verdict: "CONTAINED" | "NOT_CONTAINED" | "LANDLOCK_UNSUPPORTED";
  detail?: string;
}

function main(): number {
  const caps = probeSandboxCapabilities();
  const abi = landlockAbiVersion();

  // Build two distinct dirs: an ALLOWED workspace and a DENIED "secret" dir
  // (stand-in for .ezcorp/data — the PGlite DB + JWT secret).
  const allowedDir = mkdtempSync(join(tmpdir(), "ll-allowed-"));
  const secretDir = mkdtempSync(join(tmpdir(), "ll-secret-"));
  const allowedFile = join(allowedDir, "workspace.txt");
  const secretFile = join(secretDir, "jwt-secret.txt");
  writeFileSync(allowedFile, "ALLOWED-OK\n");
  writeFileSync(secretFile, "TOP-SECRET-JWT\n");

  const result: Result = {
    arch: caps.arch,
    landlockAbi: abi,
    tier: caps.tier,
    allowedReadOk: false,
    deniedReadBlocked: false,
    deniedErrno: null,
    verdict: "NOT_CONTAINED",
  };

  if (abi < 1) {
    result.verdict = "LANDLOCK_UNSUPPORTED";
    result.detail = `landlock_create_ruleset(VERSION) returned ${abi}`;
    emit(result);
    return 2;
  }

  // Sanity: BOTH files readable BEFORE the jail (proves the test is real).
  try {
    readFileSync(allowedFile, "utf8");
    readFileSync(secretFile, "utf8");
  } catch (e) {
    result.detail = `pre-jail read failed (broken fixture): ${String(e)}`;
    emit(result);
    return 3;
  }

  // Apply the jail: ONLY the specific allowed workspace dir (+ system dirs
  // needed to keep the Bun runtime executing) remain readable/executable.
  // We deliberately do NOT allow `/tmp` broadly — both the workspace and the
  // secret live under /tmp, so a broad /tmp grant would defeat the test.
  // `/nix` is included for the NixOS host (Bun's libc lives there); it is a
  // harmless no-op inside the Debian container.
  const allow = [
    allowedDir,
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/proc",
    "/dev",
    "/etc",
    "/nix",
  ];
  try {
    applyReadOnlyJail(allow, abi);
  } catch (e) {
    result.detail = `applyReadOnlyJail threw: ${String(e)}`;
    emit(result);
    return 4;
  }

  // (a) allowed read must still succeed
  try {
    const txt = readFileSync(allowedFile, "utf8");
    result.allowedReadOk = txt.includes("ALLOWED-OK");
  } catch (e) {
    result.detail = `allowed read FAILED post-jail: ${String(e)}`;
  }

  // (c) denied read must now fail with EACCES
  try {
    readFileSync(secretFile, "utf8");
    result.deniedReadBlocked = false;
    result.detail = "SECRET WAS READABLE AFTER JAIL — containment FAILED";
  } catch (e: any) {
    result.deniedReadBlocked = true;
    result.deniedErrno = e?.code ?? String(e);
  }

  result.verdict =
    result.allowedReadOk && result.deniedReadBlocked
      ? "CONTAINED"
      : "NOT_CONTAINED";

  emit(result);
  return result.verdict === "CONTAINED" ? 0 : 1;
}

function emit(r: Result): void {
  // Machine-readable line first, then a human summary.
  console.log("LANDLOCK_SELFTEST_JSON " + JSON.stringify(r));
  console.log(
    [
      "── Landlock fs-jail self-test ──",
      `  arch:              ${r.arch}`,
      `  landlock ABI:      ${r.landlockAbi}`,
      `  probed tier:       ${r.tier}`,
      `  allowed read OK:   ${r.allowedReadOk}`,
      `  denied read block: ${r.deniedReadBlocked}  (errno=${r.deniedErrno})`,
      `  VERDICT:           ${r.verdict}`,
      r.detail ? `  detail:            ${r.detail}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

process.exit(main());
