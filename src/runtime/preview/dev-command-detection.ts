/**
 * dev-command-detection.ts — recognize a long-running dev-server invocation
 * in a shell command string (Secure User-Site Preview / Port Exposure,
 * Phase 3b — the shell-tool spawn trigger, see tasks/preview-port-exposure.md
 * "Phase 3 sequencing", 3b "spawn integration").
 *
 * The shell tool runs arbitrary commands. Only a SUBSET — dev servers that
 * start listening and stay up — should be launched under the conversation's
 * preview uid (so the LISTEN socket is fs-isolated + uid-attributed). Normal
 * short commands (`ls`, `bun test`, `git status`) must NOT be hijacked: they
 * have no port to expose and routing them through the setuid helper would be
 * both pointless and a regression (different uid, restricted env).
 *
 * This module is PURE so the positive/negative classification is 100%
 * unit-tested without spawning anything. It returns the parsed
 * `{ command, args }` the orchestration needs (`launchPreviewDevServer`), or
 * null when the command is not a recognized dev server.
 *
 * Conservative by design: we match a curated allowlist of well-known dev
 * commands rather than a fuzzy "long-running" heuristic, because a false
 * positive (treating `bun run build` as a dev server) would silently run a
 * normal command under the wrong uid. When unsure, return null → the shell
 * tool runs the command exactly as before (fail-safe).
 */

/** The parsed dev-server launch the orchestration spawns under a preview uid. */
export interface DetectedDevCommand {
  /** The executable (no shell) — e.g. "bun", "npm", "vite", "next". */
  command: string;
  /** The remaining args — e.g. ["run", "dev"], ["dev"]. */
  args: string[];
}

/**
 * Package-manager run-scripts whose script name signals a dev server.
 * `<pm> run dev`, `<pm> dev` (npm/bun allow the bare form), `<pm> start`
 * for frameworks whose start IS the dev server (next/remix). We match the
 * SCRIPT name against `DEV_SCRIPT_NAMES`, not an exhaustive command list.
 */
const PACKAGE_MANAGERS = new Set(["npm", "bun", "pnpm", "yarn"]);

/**
 * Script names that denote a dev server (run via a package manager). Kept
 * tight: `dev`, `start`, `serve`, `preview` are the conventional SvelteKit /
 * Vite / Next / Remix dev-or-serve scripts. `build`, `test`, `lint`, etc.
 * are deliberately absent — they terminate, they don't listen.
 */
const DEV_SCRIPT_NAMES = new Set(["dev", "start", "serve", "preview"]);

/**
 * Direct dev-server binaries (invoked without a package manager). `vite`,
 * `next dev`, `astro dev`, `remix dev`, `nuxt dev`, `ng serve`, etc. The
 * binary alone (`vite`) defaults to the dev server, so it counts; a
 * sub-verb that is NOT a dev verb (`vite build`) does not.
 */
const DIRECT_DEV_BINARIES = new Set([
  "vite",
  "next",
  "astro",
  "remix",
  "nuxt",
  "ng",
  "webpack-dev-server",
  "parcel",
  "serve",
  "http-server",
]);

/** Sub-verbs that, for a DIRECT binary, denote a dev/serve mode. */
const DIRECT_DEV_VERBS = new Set(["dev", "serve", "start", "preview"]);

/**
 * Tokenize a command string into argv WITHOUT invoking a shell. This is a
 * deliberately small splitter: whitespace-separated, honoring single/double
 * quotes so a quoted path doesn't fragment. It is NOT a full shell parser —
 * if the command contains shell operators (`&&`, `|`, `;`, `$(...)`,
 * backticks, redirects) we BAIL (return null upstream) rather than guess,
 * because a compound command can't be safely run through the single-exec
 * setuid helper.
 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  // Reject shell metacharacters that imply more than one program / a
  // subshell / redirection — the helper execs ONE binary, no shell.
  if (/[|&;<>`]|\$\(|\$\{/.test(command)) return null;
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let sawChar = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawChar = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (sawChar) {
        tokens.push(cur);
        cur = "";
        sawChar = false;
      }
      continue;
    }
    cur += ch;
    sawChar = true;
  }
  if (quote) return null; // unterminated quote — malformed
  if (sawChar) tokens.push(cur);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Strip a leading env-assignment prefix (e.g. `PORT=3000 NODE_ENV=dev bun`)
 * so `PORT=5173 vite` is recognized. Returns the argv with the assignments
 * removed; an all-assignments command yields an empty array (no program).
 */
function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

/**
 * Strip an `npx`/`bunx`/`pnpm dlx`/`yarn dlx` runner prefix so
 * `npx vite` resolves to `vite`. Returns the inner argv (the runner consumed)
 * or the original when no runner prefix is present.
 */
function stripPackageRunner(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  const head = tokens[0]!;
  if (head === "npx" || head === "bunx") return tokens.slice(1);
  if ((head === "pnpm" || head === "yarn") && tokens[1] === "dlx") return tokens.slice(2);
  return tokens;
}

/**
 * Classify a shell command. Returns the `{ command, args }` to spawn under a
 * preview uid when it is a recognized dev server; null otherwise (the shell
 * tool then runs it normally).
 *
 * Recognized:
 *   - `<pm> [run] <dev-script>`         (npm/bun/pnpm/yarn run dev, bun dev)
 *   - `<direct-binary>` or `<direct-binary> <dev-verb>` (vite, next dev)
 *   - any of the above behind `npx`/`bunx`/`pnpm dlx` + env assignments
 *
 * NOT recognized (returns null): compound/shell commands, builds/tests, an
 * unknown binary, a package-manager script that isn't a dev script, a direct
 * binary with a non-dev sub-verb (vite build).
 */
export function detectDevServerCommand(command: string): DetectedDevCommand | null {
  if (!command || command.trim().length === 0) return null;
  const raw = tokenizeSimpleCommand(command);
  if (!raw) return null;

  let tokens = stripEnvAssignments(raw);
  tokens = stripPackageRunner(tokens);
  if (tokens.length === 0) return null;

  const head = tokens[0]!;

  // ── Package-manager run-script form. ──
  if (PACKAGE_MANAGERS.has(head)) {
    let rest = tokens.slice(1);
    // Optional `run` verb (`npm run dev`, `bun run dev`); bun/npm also allow
    // the bare `bun dev`. `pnpm dev` / `yarn dev` also work without `run`.
    if (rest[0] === "run") rest = rest.slice(1);
    const script = rest[0];
    if (!script || !DEV_SCRIPT_NAMES.has(script)) return null;
    // Re-derive args from the ORIGINAL post-runner tokens so the spawned
    // command preserves `run` + flags verbatim.
    return { command: head, args: tokens.slice(1) };
  }

  // ── Direct dev-server binary. ──
  // Match on the basename so `./node_modules/.bin/vite` works.
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
  if (DIRECT_DEV_BINARIES.has(base)) {
    const verb = tokens[1];
    // A bare binary (`vite`) defaults to dev/serve → accept. A leading FLAG
    // (`vite --host`) is still the default dev mode → accept. A non-flag
    // sub-verb must be a dev verb (`next dev`); a non-dev verb
    // (`next build`) → reject.
    if (verb === undefined) return { command: head, args: [] };
    if (verb.startsWith("-")) return { command: head, args: tokens.slice(1) };
    if (DIRECT_DEV_VERBS.has(verb)) return { command: head, args: tokens.slice(1) };
    return null;
  }

  return null;
}
