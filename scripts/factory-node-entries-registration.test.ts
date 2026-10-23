import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FACTORY_CONTAINER_COMMANDS } from "../src/factory/provisioning/kubernetes-profile";

// W4H-35 run 13: the orchestrator runs under Node, whose type removal is strip-only, not under Bun. A non-erasable TypeScript form in
// its runtime import graph (service-readiness.ts's parameter property, reached through metric-registry.ts) stopped it at load with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX while every Bun-run test passed. So each entry the profiles run with `node` is loaded here by the
// pinned Node: ES module linking parses the entry's whole static graph before any of it runs, and the entry's own main guard keeps
// its main off. A standing guard (a scripts/*-registration suite): the fast stage runs it on every change, whatever the diff.
const ROOT = resolve(import.meta.dir, "..");
const PINNED = readFileSync(resolve(ROOT, ".node-version"), "utf8").trim();
// The pinned Node: the gated runs name it (w00 node_pin exports NODE_PIN_DIR); CI's setup-node puts the .node-version Node on PATH.
// Either way its version must be exactly the pin; nothing is downloaded here.
const NODE = process.env.NODE_PIN_DIR ? resolve(process.env.NODE_PIN_DIR, "node") : Bun.which("node") ?? "";
// Every command the profiles run: the tenant containers' table, every Compose file's services, and the commands the Kubernetes
// renderer writes inline (the pool and supervisor DaemonSets).
const COMPOSE = resolve(ROOT, "deploy/factory/compose");
const composeCommands = readdirSync(COMPOSE).filter((file) => file.endsWith(".yml")).flatMap((file) =>
  Object.values((Bun.YAML.parse(readFileSync(resolve(COMPOSE, file), "utf8")) as { services?: Record<string, { command?: string[] }> }).services ?? {}).map((service) => service.command ?? []));
const inlineCommands = [...readFileSync(resolve(ROOT, "src/factory/provisioning/kubernetes-profile.ts"), "utf8").matchAll(/\["(\w+)", "([^"]+)"/g)].map((match) => [match[1]!, match[2]!]);
const nodeEntries = [...new Set([...Object.values(FACTORY_CONTAINER_COMMANDS), ...composeCommands, ...inlineCommands]
  .filter((command) => command[0] === "node").map((command) => command[1]!))];

describe("the entries the profiles run with node", () => {
  test("both profiles name them, and the orchestrator is one", () => {
    expect(nodeEntries).toContain("src/factory/orchestration-process.ts");
  });

  test("the node that loads them is the pinned one: .node-version, the image's node", () => {
    expect({ node: NODE, exists: NODE !== "" && existsSync(NODE) }).toEqual({ node: NODE, exists: true });
    expect(Bun.spawnSync([NODE, "--version"]).stdout.toString().trim()).toBe(`v${PINNED}`);
    expect(readFileSync(resolve(ROOT, "deploy/factory/Dockerfile"), "utf8")).toContain(`ARG NODE_IMAGE=docker.io/library/node:${PINNED}-`);
  });

  for (const entry of nodeEntries) {
    test(`node loads ${entry} with its type removal in strip-only mode`, () => {
      const loaded = Bun.spawnSync([NODE, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(resolve(ROOT, entry)).href)})`], { cwd: ROOT, timeout: 60_000 });
      const error = loaded.stderr.toString().split("\n").find((line) => /^\w*Error\b/.test(line)) ?? "";
      expect({ entry, exit: loaded.exitCode, error }).toEqual({ entry, exit: 0, error: "" });
    }, 90_000);
  }
});
