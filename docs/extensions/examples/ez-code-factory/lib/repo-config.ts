// ── Trusted-branch repo config — the M3 supply-chain security boundary ──
//
// Port of internal/config/config.go (RepoConfig, EffectiveRepoConfig) +
// internal/daemon/manager.go (loadTrustedRepoConfig,
// assertGateTrustedConfigReadable, the startRun fetch→resolve→assert flow) —
// the v1.30.2 fix for a supply-chain-RCE-class bug (spec §1 invariant 1).
//
// THE RULE: the CODE-EXECUTING selection fields of the per-repo config —
// `commands.{test,lint,format}` (run verbatim via `sh -c` on the daemon host),
// `agent` (selects which sub-agent launches), `document.instructions` (injected
// into the document gate prompt), `disable_project_settings`, and the
// `allow_repo_commands` opt-in flag ITSELF — are read ONLY from the freshly-
// fetched DEFAULT branch at a resolved commit, NEVER the pushed SHA. A
// contributor's pushed branch therefore cannot inject shell, pick an agent, or
// weaken the rules that gate its own review. `allow_repo_commands:true` (a
// trusted-branch value) is the ONLY thing that lets the pushed branch's
// commands/agent be honored; `document.instructions` + `disable_project_settings`
// are trusted-branch-only UNCONDITIONALLY (even allow_repo_commands does not
// unlock them from the pushed branch). Non-executing keys (`ignore_patterns`,
// `test.evidence`) always come from the pushed copy — they cannot run shell or
// select a process. If the default branch cannot be fetched/resolved/parsed the
// run ABORTS before launching ANY agent (fail closed).
//
// Config-file format: `.ez-code-factory.json` (JSON, not YAML). JSON is chosen
// over upstream's `.no-mistakes.yaml` deliberately: it parses with the runtime's
// native `JSON.parse` (no YAML dependency — adding one would be an unverifiable
// package install), and it matches the extension ecosystem's config-json
// convention (CLAUDE.md "Extension data"). Keys mirror upstream's YAML names
// (snake_case) so a repo author's mental model carries over verbatim.

import type { Git } from "./git";

/** The repo-config file read from a git ref (never the working tree — the
 *  sandbox poisons node:fs, and reading at a pinned SHA is the security point). */
export const REPO_CONFIG_FILE = ".ez-code-factory.json";

/** Default in-repo evidence directory (renamed from upstream `.no-mistakes/evidence`). */
export const DEFAULT_EVIDENCE_DIR = ".ez-code-factory/evidence";

// ── Parsed shape ─────────────────────────────────────────────────────

/** Executing shell commands (trusted-branch-gated). */
export interface RepoCommands {
  test: string;
  lint: string;
  format: string;
}

/** Repository-specific documentation ownership policy (trusted-only). */
export interface RepoDocument {
  instructions: string;
}

/** Test-evidence storage settings (non-executing → pushed branch). */
export interface RepoEvidence {
  storeInRepo: boolean;
  dir: string;
}

/**
 * The parsed `.ez-code-factory.json`. Mirrors the fields upstream's RepoConfig
 * exposes to the pipeline; every scalar carries a safe default so a partial
 * config never yields `undefined` at a decision point.
 */
export interface RepoConfig {
  /** Executing (trusted-gated unless allow_repo_commands). */
  commands: RepoCommands;
  /** Executing agent selection (trusted-gated unless allow_repo_commands). */
  agent: string;
  /** Trusted-branch-only opt-in that unlocks pushed commands/agent. */
  allowRepoCommands: boolean;
  /** Trusted-branch-only documentation policy. */
  document: RepoDocument;
  /** Trusted-branch-only project-instruction boundary. */
  disableProjectSettings: boolean;
  /** Non-executing review/document ignore globs (pushed branch). */
  ignorePatterns: string[];
  /** Non-executing test-evidence settings (pushed branch). */
  evidence: RepoEvidence;
}

/** An empty, fully-formed RepoConfig (secure defaults: no commands/agent, not
 *  opted in, project settings ON, evidence off + default dir). */
export function emptyRepoConfig(): RepoConfig {
  return {
    commands: { test: "", lint: "", format: "" },
    agent: "",
    allowRepoCommands: false,
    document: { instructions: "" },
    disableProjectSettings: false,
    ignorePatterns: [],
    evidence: { storeInRepo: false, dir: DEFAULT_EVIDENCE_DIR },
  };
}

/** Coerce an unknown to a trimmed-preserving string, defaulting to "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** First present string among `keys` on `o` (snake_case wire, camelCase alias). */
function pickStr(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return "";
}

/** Object at `key` on `o`, or an empty record. */
function obj(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse raw `.ez-code-factory.json` bytes into a RepoConfig. Returns null ONLY
 * when the content is not valid JSON (mirrors upstream's parseRepoConfig error
 * → the caller treats an unparseable trusted config as fail-closed / abort). A
 * valid-JSON-but-partial object yields a RepoConfig with defaults for the
 * missing fields.
 */
export function parseRepoConfig(raw: string): RepoConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A JSON scalar / array is not a config object; treat as unparseable so a
    // hostile `"true"` or `[]` at the config path fails closed rather than
    // silently becoming an all-defaults (and thus "not opted out") config.
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const cfg = emptyRepoConfig();

  const commands = obj(o, "commands");
  cfg.commands.test = str(commands.test);
  cfg.commands.lint = str(commands.lint);
  cfg.commands.format = str(commands.format);

  cfg.agent = str(o.agent);
  cfg.allowRepoCommands = o.allow_repo_commands === true || o.allowRepoCommands === true;

  const document = obj(o, "document");
  cfg.document.instructions = pickStr(document, "instructions");

  cfg.disableProjectSettings =
    o.disable_project_settings === true || o.disableProjectSettings === true;

  const rawIgnore = o.ignore_patterns ?? o.ignorePatterns;
  if (Array.isArray(rawIgnore)) {
    cfg.ignorePatterns = rawIgnore.filter((x): x is string => typeof x === "string");
  }

  const test = obj(o, "test");
  const evidence = obj(test, "evidence");
  cfg.evidence.storeInRepo =
    evidence.store_in_repo === true || evidence.storeInRepo === true;
  const evDir = pickStr(evidence, "dir");
  if (evDir.trim() !== "") cfg.evidence.dir = evDir;

  return cfg;
}

// ── EffectiveRepoConfig — the pure security decision ────────────────

/**
 * Merge a pushed-branch copy with the trusted default-branch copy into the
 * config that actually drives the pipeline. Verbatim port of
 * config.go EffectiveRepoConfig:
 *
 *  - `document` + `disableProjectSettings` come from the trusted copy ONLY
 *    (forced to defaults when there is no trusted copy) — UNCONDITIONALLY, even
 *    when allow_repo_commands is true.
 *  - When `allowRepoCommands` is true (a value read only from the trusted copy),
 *    the pushed branch's `commands` + `agent` are honored.
 *  - Otherwise `commands` + `agent` come from the trusted copy (or are forced
 *    empty when there is no trusted copy) — NEVER the pushed branch.
 *  - Non-executing keys (`ignorePatterns`, `evidence`) always come from the
 *    pushed copy.
 *
 * `pushed`/`trusted` null means the config was absent on that branch.
 */
export function effectiveRepoConfig(
  pushed: RepoConfig | null,
  trusted: RepoConfig | null,
  allowRepoCommands: boolean,
): RepoConfig {
  const base = pushed ?? emptyRepoConfig();
  // Deep-copy the mutable sub-objects so the returned config never aliases the
  // caller's inputs (a later mutation of `pushed` must not leak in).
  const effective: RepoConfig = {
    commands: { ...base.commands },
    agent: base.agent,
    allowRepoCommands: base.allowRepoCommands,
    document: { ...base.document },
    disableProjectSettings: base.disableProjectSettings,
    ignorePatterns: [...base.ignorePatterns],
    evidence: { ...base.evidence },
  };

  // document + disable_project_settings: trusted-only, unconditionally.
  if (trusted) {
    effective.document = { ...trusted.document };
    effective.disableProjectSettings = trusted.disableProjectSettings;
  } else {
    effective.document = { instructions: "" };
    effective.disableProjectSettings = false;
  }

  if (allowRepoCommands) {
    // The maintainer explicitly opted in (on the trusted branch) to honoring the
    // pushed branch's commands/agent — leave `base`'s pushed values in place.
    return effective;
  }

  // Secure default: commands + agent come from the trusted copy, or are forced
  // empty when there is none (NEVER the pushed branch).
  if (trusted) {
    effective.commands = { ...trusted.commands };
    effective.agent = trusted.agent;
  } else {
    effective.commands = { test: "", lint: "", format: "" };
    effective.agent = "";
  }
  return effective;
}

// ── Git-driven resolution (daemon manager.go) ───────────────────────

/** Raised when the trusted default-branch config could not be READ at all —
 *  the run must abort before launching any agent (fail closed). Verbatim
 *  assertGateTrustedConfigReadable's error family. */
export class TrustedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedConfigError";
  }
}

/**
 * Fail LOUD when the trusted default-branch copy of the config could not be read
 * at all. Distinguishes "could not read the trusted config" (abort) from "read
 * the trusted tree fine, there is simply no config on the default branch" (the
 * common ordinary-repo case → proceed, not opted out). Verbatim
 * assertGateTrustedConfigReadable. Abort cases:
 *   - no known default branch to read a trusted copy from,
 *   - the default branch could not be fetched/resolved to a pinned SHA,
 *   - the pinned commit or tree is not readable (missing object / partial fetch),
 *   - the trusted config is present but unreadable or unparseable.
 */
export async function assertGateTrustedConfigReadable(
  git: Git,
  defaultBranch: string,
  trustedSHA: string,
): Promise<void> {
  if (defaultBranch.trim() === "") {
    throw new TrustedConfigError(
      "cannot evaluate trusted repo config: repository has no known default branch to read trusted config from",
    );
  }
  if (trustedSHA.trim() === "") {
    throw new TrustedConfigError(
      `cannot evaluate trusted repo config: failed to fetch or resolve trusted default branch "${defaultBranch}" ` +
        `(refusing to run without reading the trusted config)`,
    );
  }
  const commit = await git.try("rev-parse", "-q", "--verify", `${trustedSHA}^{commit}`);
  if (commit.exitCode !== 0) {
    throw new TrustedConfigError(
      `cannot evaluate trusted repo config: trusted default-branch commit ${trustedSHA} is not readable`,
    );
  }
  const entry = await git.try("ls-tree", trustedSHA, "--", REPO_CONFIG_FILE);
  if (entry.exitCode !== 0) {
    throw new TrustedConfigError(
      `cannot evaluate trusted repo config: trusted default-branch tree at ${trustedSHA} is not readable`,
    );
  }
  if (entry.stdout.trim() === "") {
    // Ordinary repo: the config is simply absent on the default branch — not
    // opted out, proceed.
    return;
  }
  const show = await git.try("show", `${trustedSHA}:${REPO_CONFIG_FILE}`);
  if (show.exitCode !== 0) {
    throw new TrustedConfigError(
      `cannot evaluate trusted repo config: trusted ${REPO_CONFIG_FILE} at ${trustedSHA} is present but not readable`,
    );
  }
  if (parseRepoConfig(show.stdout) === null) {
    throw new TrustedConfigError(
      `cannot evaluate trusted repo config: trusted ${REPO_CONFIG_FILE} at ${trustedSHA} is present but unparseable`,
    );
  }
}

/**
 * Read `.ez-code-factory.json` from the trusted default-branch commit
 * (`trustedSHA` — the exact SHA the resolver just fetched + resolved) and parse
 * it. Reading at a pinned SHA, not the `origin/<default>` remote-tracking ref,
 * closes the stale-ref hole. Returns null when the path is absent (the common
 * "no trusted commands" case) — the caller must first reject an UNREADABLE
 * trusted config via assertGateTrustedConfigReadable. Verbatim loadTrustedRepoConfig.
 */
export async function loadTrustedRepoConfig(git: Git, trustedSHA: string): Promise<RepoConfig | null> {
  if (trustedSHA.trim() === "") return null;
  const show = await git.try("show", `${trustedSHA}:${REPO_CONFIG_FILE}`);
  if (show.exitCode !== 0) return null;
  return parseRepoConfig(show.stdout);
}

/**
 * Read the pushed-branch copy of the config from `ref` (the worktree HEAD at the
 * pushed SHA). Non-executing keys (ignore patterns, evidence) are taken from
 * here; executing keys are ignored unless the trusted copy opts in. Returns null
 * when absent or unparseable — a hostile / broken pushed config never aborts the
 * run (only the trusted read can), it just contributes no non-executing overlays.
 */
export async function loadPushedRepoConfig(git: Git, ref: string): Promise<RepoConfig | null> {
  const show = await git.try("show", `${ref}:${REPO_CONFIG_FILE}`);
  if (show.exitCode !== 0) return null;
  return parseRepoConfig(show.stdout);
}

/**
 * The end-to-end trusted-config resolver a run performs BEFORE launching any
 * agent. Fetches the default branch, resolves it to a pinned SHA, asserts the
 * trusted config is readable (throws TrustedConfigError → the run aborts fail-
 * closed), then loads the trusted + pushed copies and merges them via
 * effectiveRepoConfig. `pushedRef` is the ref to read the pushed copy from
 * (normally "HEAD", the worktree's checked-out pushed SHA). Mirrors the daemon's
 * startRun fetch→resolve→assert→EffectiveRepoConfig sequence.
 */
export async function resolveTrustedRepoConfig(
  git: Git,
  defaultBranch: string,
  pushedRef: string,
): Promise<RepoConfig> {
  let trustedSHA = "";
  if (defaultBranch.trim() !== "") {
    const fetched = await git.fetchRemoteBranch("origin", defaultBranch);
    if (fetched.exitCode === 0) {
      const sha = await git.revParseVerify(`refs/remotes/origin/${defaultBranch}^{commit}`);
      if (sha) trustedSHA = sha;
    }
  }
  // Fail closed on an unreadable trusted config BEFORE any load/merge/dispatch.
  await assertGateTrustedConfigReadable(git, defaultBranch, trustedSHA);
  const trusted = await loadTrustedRepoConfig(git, trustedSHA);
  const pushed = await loadPushedRepoConfig(git, pushedRef);
  const allowRepoCommands = trusted !== null && trusted.allowRepoCommands;
  return effectiveRepoConfig(pushed, trusted, allowRepoCommands);
}
