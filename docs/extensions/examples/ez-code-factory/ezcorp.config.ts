import { defineExtension } from "../../../../src/extensions/sdk/define";

// ── ez-code-factory — no-mistakes-style git "gate" as an EZCorp extension ──
//
// M0 (gate bring-up): `git push gate <branch>` on a target repo lands objects
// in a LOCAL bare gate repo whose `post-receive` hook POSTs the EXISTING
// generic extension-events route; the extension records a run, materializes a
// detached worktree, and tears it down. No pipeline steps yet — everything
// downstream (review/test/lint/PR/CI) arrives in later milestones.
//
// This is an INSTALLABLE example extension (not bundled): M0 never touches
// BUNDLED_EXTENSIONS, manifest.lock.json, or bundled-ceiling.ts.
export default defineExtension({
  schemaVersion: 2,
  name: "ez-code-factory",
  version: "0.1.0",
  description:
    "A local git 'gate' that intercepts `git push gate <branch>` in front of " +
    "your real remote: the push lands in a bare gate repo whose post-receive " +
    "hook triggers this extension, which records a run, checks the pushed " +
    "commit out into a disposable detached worktree, and (in later milestones) " +
    "runs a fixed review/test/lint/PR/CI pipeline before force-pushing " +
    "upstream. M0 brings up the gate + run/worktree lifecycle + Hub dashboard.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["hub", "pages", "git", "gate", "ci", "control-plane"],

  tools: [
    {
      name: "init_gate",
      description:
        "Idempotently provision the git gate for the ACTIVE project: create a " +
        "local bare gate repo under the extension's data dir, install a managed " +
        "post-receive hook, enable push-option advertisement + per-worktree " +
        "hook isolation, point the gate repo's `origin` at the project's " +
        "upstream, and add a `gate` remote to the working repo (refusing to " +
        "clobber a foreign remote of the same name). Safe to re-run: it only " +
        "rewrites hooks it wrote itself and only repoints gate wiring it owns. " +
        "After running, `git push gate <branch>` routes the push through this " +
        "extension. Returns the gate repo id + paths.",
      inputSchema: {
        type: "object",
        properties: {
          upstream: {
            type: "string",
            description:
              "OPTIONAL upstream URL the gate repo's `origin` should point at. " +
              "Omit to reuse the working repo's existing `origin` URL.",
          },
        },
      },
    },
  ],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the tab appears at /hub/ext:ez-code-factory:dashboard once the
  // extension is enabled.
  pages: [
    {
      id: "dashboard",
      title: "ez-code-factory",
      icon: "GitBranch",
      description:
        "Gate runs — one row per `git push gate` intercepted, with branch, " +
        "head SHA, and lifecycle status, refreshed live via a content-free " +
        "page-state SSE signal.",
    },
  ],

  permissions: {
    // Self-tracked run/step records (the run history the dashboard renders).
    storage: true,
    // git orchestration (init-gate + per-run worktree lifecycle) shells `git`.
    // The `gate` remote's post-receive hook — installed on the gate repo, run
    // by git at push time — is what calls back into the platform; the
    // extension subprocess itself makes no network calls in M0, so no
    // `network` grant is requested (narrowest grants).
    shell: true,
    // Gate repo + managed hook + credential file all live under
    // <projectRoot>/.ezcorp/extension-data/ez-code-factory/ (a `$CWD`-relative
    // path). Per-run worktrees live under the host-provided per-extension
    // TMPDIR (granted separately by the host), never under the project root.
    filesystem: ["$CWD"],
    // The post-receive hook's callback targets THIS extension's `push-received`
    // Hub action via the generic extension-events route. Declaring the event
    // both wires the page action and lets the events route accept the hook's
    // POST (the route 404s undeclared events).
    eventSubscriptions: ["ez-code-factory:push-received"],
  },

  resources: {
    memory: "128MB",
  },
});
