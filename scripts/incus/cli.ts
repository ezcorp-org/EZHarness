#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncusConnection, IncusInventory, IncusSetupPlan, IncusSetupRecipe } from "./model";
import { applySetupPlan } from "./apply";
import { inspectIncus, sshRunner } from "./inspect";
import { createSetupPlan, verifySetupPlan } from "./plan";

type Options = Record<string, string | boolean>;

function parse(argv: string[]): { command: string; options: Options } {
  const command = argv.shift();
  if (!command || !["inspect", "plan", "apply", "verify"].includes(command)) throw new Error("usage: cli.ts <inspect|plan|apply|verify> [--name value] [--execute]");
  const options: Options = {};
  while (argv.length) {
    const flag = argv.shift()!;
    if (!/^--[a-z][a-z-]*$/.test(flag)) throw new Error(`invalid argument ${flag}`);
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option --${name}`);
    if (name === "execute") options[name] = true;
    else {
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      options[name] = value;
    }
  }
  return { command, options };
}

function required(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
}

async function load<Result>(path: string): Promise<Result> {
  const value = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value as Result;
}

async function save(path: string | undefined, value: unknown): Promise<void> {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(resolve(path), output, { flag: "wx", mode: 0o600 });
  else process.stdout.write(output);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = parse(argv);
  if (command === "inspect") {
    const connection = await load<IncusConnection>(required(options, "connection"));
    await save(typeof options.out === "string" ? options.out : undefined, await inspectIncus(connection));
    return;
  }
  const recipe = await load<IncusSetupRecipe>(required(options, "recipe"));
  if (command === "plan") {
    const inventory = await load<IncusInventory>(required(options, "inventory"));
    await save(typeof options.out === "string" ? options.out : undefined, createSetupPlan(recipe, inventory));
    return;
  }
  const plan = await load<IncusSetupPlan>(required(options, "plan"));
  const connection = await load<IncusConnection>(required(options, "connection"));
  if (command === "apply") {
    const execute = options.execute === true;
    const preflightPlan = createSetupPlan(recipe, await inspectIncus(connection));
    const receipt = await applySetupPlan(plan, sshRunner(connection), { execute, preflightPlan, ...(execute ? { approvedPlanDigest: required(options, "approved-plan-digest") } : {}) });
    await save(typeof options.out === "string" ? options.out : undefined, receipt);
    if (["blocked", "reconcile_required", "review_required"].includes(receipt.state)) process.exitCode = 1;
    return;
  }
  const inventory = await inspectIncus(connection);
  const failures = verifySetupPlan(plan, recipe, inventory);
  await save(typeof options.out === "string" ? options.out : undefined, { schemaVersion: 1, planDigest: plan.planDigest, inventory, failures, ready: failures.length === 0 });
  if (failures.length) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

export { main, parse };
