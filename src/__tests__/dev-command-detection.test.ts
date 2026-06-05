/**
 * Secure User-Site Preview — Phase 3b. Dev-command detection: the pure
 * classifier that decides whether a shell command is a long-running dev
 * server (→ launch under a preview uid) or a normal command (→ run as-is).
 *
 * Coverage: positive forms (pm run-scripts, bare bun/pnpm/yarn, direct
 * binaries, npx/bunx runners, env-assignment prefixes) + negative forms
 * (builds/tests, compound shell commands, unknown binaries, non-dev verbs,
 * malformed quoting) — both directions are load-bearing: a false positive
 * silently runs a normal command under the wrong uid.
 */
import { test, expect, describe } from "bun:test";
import {
  detectDevServerCommand,
  tokenizeSimpleCommand,
} from "../runtime/preview/dev-command-detection";

describe("tokenizeSimpleCommand", () => {
  test("splits on whitespace", () => {
    expect(tokenizeSimpleCommand("bun run dev")).toEqual(["bun", "run", "dev"]);
  });

  test("honors single + double quotes", () => {
    expect(tokenizeSimpleCommand(`vite --config "my config.js"`)).toEqual([
      "vite",
      "--config",
      "my config.js",
    ]);
    expect(tokenizeSimpleCommand(`echo 'a b'`)).toEqual(["echo", "a b"]);
  });

  test("bails on shell metacharacters", () => {
    expect(tokenizeSimpleCommand("bun dev && echo hi")).toBeNull();
    expect(tokenizeSimpleCommand("bun dev | tee log")).toBeNull();
    expect(tokenizeSimpleCommand("bun dev; ls")).toBeNull();
    expect(tokenizeSimpleCommand("echo $(whoami)")).toBeNull();
    expect(tokenizeSimpleCommand("echo `id`")).toBeNull();
    expect(tokenizeSimpleCommand("vite > out.log")).toBeNull();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax under test
    expect(tokenizeSimpleCommand("echo ${HOME}")).toBeNull();
  });

  test("bails on an unterminated quote / empty", () => {
    expect(tokenizeSimpleCommand(`vite "unterminated`)).toBeNull();
    expect(tokenizeSimpleCommand("   ")).toBeNull();
  });
});

describe("detectDevServerCommand — POSITIVE (recognized dev servers)", () => {
  const cases: Array<[string, { command: string; args: string[] }]> = [
    ["npm run dev", { command: "npm", args: ["run", "dev"] }],
    ["bun run dev", { command: "bun", args: ["run", "dev"] }],
    ["pnpm run dev", { command: "pnpm", args: ["run", "dev"] }],
    ["yarn run dev", { command: "yarn", args: ["run", "dev"] }],
    ["bun dev", { command: "bun", args: ["dev"] }],
    ["pnpm dev", { command: "pnpm", args: ["dev"] }],
    ["npm run start", { command: "npm", args: ["run", "start"] }],
    ["npm run serve", { command: "npm", args: ["run", "serve"] }],
    ["npm run preview", { command: "npm", args: ["run", "preview"] }],
    ["vite", { command: "vite", args: [] }],
    ["vite --host", { command: "vite", args: ["--host"] }],
    ["next dev", { command: "next", args: ["dev"] }],
    ["astro dev", { command: "astro", args: ["dev"] }],
    ["ng serve", { command: "ng", args: ["serve"] }],
    ["./node_modules/.bin/vite", { command: "./node_modules/.bin/vite", args: [] }],
  ];
  for (const [cmd, expected] of cases) {
    test(`recognizes \`${cmd}\``, () => {
      expect(detectDevServerCommand(cmd)).toEqual(expected);
    });
  }

  test("strips an npx/bunx runner prefix", () => {
    expect(detectDevServerCommand("npx vite")).toEqual({ command: "vite", args: [] });
    expect(detectDevServerCommand("bunx vite --host")).toEqual({ command: "vite", args: ["--host"] });
    expect(detectDevServerCommand("pnpm dlx vite")).toEqual({ command: "vite", args: [] });
  });

  test("strips a leading env-assignment prefix", () => {
    expect(detectDevServerCommand("PORT=5173 vite")).toEqual({ command: "vite", args: [] });
    expect(detectDevServerCommand("NODE_ENV=dev PORT=3000 bun run dev")).toEqual({
      command: "bun",
      args: ["run", "dev"],
    });
  });
});

describe("detectDevServerCommand — NEGATIVE (not a dev server)", () => {
  const negatives = [
    "bun run build",
    "npm run test",
    "npm run lint",
    "bun test",
    "vite build",
    "next build",
    "ng build",
    "ls -la",
    "git status",
    "cat package.json",
    "echo hello",
    "bun install",
    "bun dev && echo done", // compound — bails
    "bun run dev | cat", // piped — bails
    "node server.js", // not in the allowlist
    "pnpm dlx some-unknown-tool", // runner but unknown binary
    "PORT=3000", // only an assignment, no program
    "", // empty
    "   ", // whitespace
  ];
  for (const cmd of negatives) {
    test(`rejects \`${cmd || "(empty)"}\``, () => {
      expect(detectDevServerCommand(cmd)).toBeNull();
    });
  }

  test("a package-manager script that is not a dev script → null", () => {
    expect(detectDevServerCommand("npm run typecheck")).toBeNull();
    expect(detectDevServerCommand("bun run migrate")).toBeNull();
  });
});
