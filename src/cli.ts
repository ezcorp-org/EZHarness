import { loadAgents } from "./runtime/loader";
import { EventBus } from "./runtime/events";
import { AgentExecutor } from "./runtime/executor";
import { PipelineExecutor } from "./runtime/pipeline-executor";
import { loadYamlPipelines } from "./runtime/pipeline-loader";
import { formatAgentList } from "./ui/format";
import { connectToEventBus } from "./ui/terminal";
import type { AgentEvents } from "./types";
import { initDb } from "./db/connection";
import { getProjectByName } from "./db/queries/projects";
import { loadDbPipelines } from "./db/queries/pipelines";
import { installFromLocal, installWithDependencies, updateExtension as updateExt, removeExtension as removeExt, checkForUpdates } from "./extensions/installer";
import { satisfiesRange } from "./extensions/manifest";
import type { DependencyTreeNode } from "./extensions/dependency-resolver";
import { listExtensions, getExtensionByName } from "./db/queries/extensions";
import { getRequiredPermissions } from "./extensions/permissions";
import type { ExtensionPermissions, ExtensionManifestV2 } from "./extensions/types";
import { createInterface } from "node:readline";

// ── Permission Prompting ─────────────────────────────────────────────

async function promptForPermissions(
  manifest: ExtensionManifestV2,
  autoApprove: boolean,
): Promise<ExtensionPermissions> {
  const perms = manifest.permissions;
  const now = Date.now();

  // Auto-approve: grant all requested permissions
  if (autoApprove) {
    return buildFullPermissions(perms, now);
  }

  // Non-interactive: require --yes flag
  if (!process.stdin.isTTY) {
    throw new Error("Interactive terminal required for permission prompting. Use --yes to auto-approve.");
  }

  const items = getRequiredPermissions(manifest);
  if (items.length === 0) {
    return { grantedAt: {} }; // no permissions requested
  }

  // Display requested permissions
  console.log(`\nExtension "${manifest.name}" requests the following permissions:\n`);

  if (perms.network?.length) {
    console.log("  Network access:");
    for (const d of perms.network) console.log(`    - ${d}`);
    console.log();
  }
  if (perms.filesystem?.length) {
    console.log("  Filesystem access:");
    for (const p of perms.filesystem) console.log(`    - ${p}`);
    console.log();
  }
  if (perms.shell) {
    console.log("  Shell command execution\n");
  }
  if (perms.env?.length) {
    console.log("  Environment variables:");
    for (const v of perms.env) console.log(`    - ${v}`);
    console.log();
  }

  const answer = await askUser("Approve all permissions? [y/N/select] ");
  const choice = answer.trim().toLowerCase();

  if (choice === "y" || choice === "yes") {
    return buildFullPermissions(perms, now);
  }

  if (choice === "s" || choice === "select") {
    return promptPerCategory(perms, now);
  }

  // Default: deny all
  return { grantedAt: {} };
}

function buildFullPermissions(
  perms: ExtensionManifestV2["permissions"],
  now: number,
): ExtensionPermissions {
  const granted: ExtensionPermissions = { grantedAt: {} };
  if (perms.network?.length) { granted.network = perms.network; granted.grantedAt.network = now; }
  if (perms.filesystem?.length) { granted.filesystem = perms.filesystem; granted.grantedAt.filesystem = now; }
  if (perms.shell) { granted.shell = true; granted.grantedAt.shell = now; }
  if (perms.env?.length) { granted.env = perms.env; granted.grantedAt.env = now; }
  return granted;
}

async function promptPerCategory(
  perms: ExtensionManifestV2["permissions"],
  now: number,
): Promise<ExtensionPermissions> {
  const granted: ExtensionPermissions = { grantedAt: {} };

  if (perms.network?.length) {
    const a = await askUser(`  Allow network access to ${perms.network.join(", ")}? [y/N] `);
    if (a.trim().toLowerCase() === "y") {
      granted.network = perms.network;
      granted.grantedAt.network = now;
    }
  }
  if (perms.filesystem?.length) {
    const a = await askUser(`  Allow filesystem access to ${perms.filesystem.join(", ")}? [y/N] `);
    if (a.trim().toLowerCase() === "y") {
      granted.filesystem = perms.filesystem;
      granted.grantedAt.filesystem = now;
    }
  }
  if (perms.shell) {
    const a = await askUser("  Allow shell command execution? [y/N] ");
    if (a.trim().toLowerCase() === "y") {
      granted.shell = true;
      granted.grantedAt.shell = now;
    }
  }
  if (perms.env?.length) {
    const a = await askUser(`  Allow reading env vars: ${perms.env.join(", ")}? [y/N] `);
    if (a.trim().toLowerCase() === "y") {
      granted.env = perms.env;
      granted.grantedAt.env = now;
    }
  }

  return granted;
}

function askUser(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Arg parsing ─────────────────────────────────────────────────────

export interface ParsedArgs {
  command: string;
  agentName?: string;
  pipelineName?: string;
  input?: Record<string, unknown>;
  port?: number;
  project?: string;
  source?: string;       // for ext:install
  extName?: string;      // for ext:update, ext:remove, ext:info
  extDir?: string;       // for ext:dev, ext:test
  autoApprove?: boolean; // --yes flag for ext:install
  force?: boolean;       // --force flag for ext:remove
  filter?: string;       // for ext:test --filter
  type?: string;         // for ext:init --type
  token?: string;        // for ext:publish --token
}

export function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";

  if (command === "list" || command === "help") {
    return { command };
  }

  if (command === "run") {
    const agentName = args[1];
    let input: Record<string, unknown> | undefined;
    const inputIdx = args.indexOf("--input");
    if (inputIdx !== -1 && args[inputIdx + 1]) {
      input = JSON.parse(args[inputIdx + 1]!);
    }
    let project: string | undefined;
    const projectIdx = args.indexOf("--project");
    if (projectIdx !== -1 && args[projectIdx + 1]) {
      project = args[projectIdx + 1]!;
    }
    return { command, agentName, input, project };
  }

  if (command === "pipeline") {
    const subCommand = args[1];
    if (subCommand === "list") {
      return { command: "pipeline:list" };
    }
    if (subCommand === "run") {
      const pipelineName = args[2];
      let input: Record<string, unknown> | undefined;
      const inputIdx = args.indexOf("--input");
      if (inputIdx !== -1 && args[inputIdx + 1]) {
        input = JSON.parse(args[inputIdx + 1]!);
      }
      let project: string | undefined;
      const projectIdx = args.indexOf("--project");
      if (projectIdx !== -1 && args[projectIdx + 1]) {
        project = args[projectIdx + 1]!;
      }
      return { command: "pipeline:run", pipelineName, input, project };
    }
    return { command: "help" };
  }

  if (command === "ext") {
    const sub = args[1];
    switch (sub) {
      case "init": {
        const typeIdx = args.indexOf("--type");
        return {
          command: "ext:init",
          extName: args[2],
          type: typeIdx !== -1 ? args[typeIdx + 1] : undefined,
        };
      }
      case "install":
        return { command: "ext:install", source: args[2], autoApprove: args.includes("--yes") };
      case "update":
        return { command: "ext:update", extName: args[2] };
      case "list":
        return { command: "ext:list" };
      case "remove":
        return { command: "ext:remove", extName: args[2], force: args.includes("--force") };
      case "info":
        return { command: "ext:info", extName: args[2] };
      case "dev":
        return { command: "ext:dev", extDir: args[2] };
      case "test":
        return {
          command: "ext:test",
          extDir: args[2],
          filter: args.indexOf("--filter") !== -1 ? args[args.indexOf("--filter") + 1] : undefined,
        };
      case "publish": {
        const tokenIdx = args.indexOf("--token");
        return {
          command: "ext:publish",
          token: tokenIdx !== -1 ? args[tokenIdx + 1] : undefined,
        };
      }
      default:
        return { command: "help" };
    }
  }

  if (command === "serve") {
    let port = 3001;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1]!, 10);
    }
    return { command, port };
  }

  return { command: "help" };
}

// ── Usage text ──────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
EZCorp - AI Platform

Usage:
  ezcorp list                                          List available agents
  ezcorp run <agent> [--input '{}'] [--project <name>] Run an agent
  ezcorp pipeline list                                 List pipelines
  ezcorp pipeline run <name> [--input '{}'] [--project <name>] Run a pipeline
  ezcorp ext init <name> [--type tool|skill|agent|multi] Create new extension project
  ezcorp ext install <source> [--yes]                   Install extension from git
  ezcorp ext update [name]                              Update extension(s)
  ezcorp ext list                                       List installed extensions
  ezcorp ext remove <name>                              Remove an extension
  ezcorp ext info <name>                                Show extension details
  ezcorp ext dev [dir]                                  Start dev server with hot reload
  ezcorp ext test [dir] [--filter <name>]               Run extension tests in sandbox
  ezcorp ext publish [--token <token>]                  Publish extension to marketplace
  ezcorp serve [--port 3001]                           Start API server
  ezcorp help                                          Show this help
`.trim());
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Find all extensions that declare targetName as a dependency. */
async function findDependents(targetName: string, allExts?: Awaited<ReturnType<typeof listExtensions>>): Promise<string[]> {
  const exts = allExts ?? await listExtensions();
  const dependents: string[] = [];
  for (const other of exts) {
    const otherManifest = other.manifest as ExtensionManifestV2;
    if (otherManifest.dependencies && targetName in otherManifest.dependencies) {
      dependents.push(other.name);
    }
  }
  return dependents;
}

// ── CLI entry ───────────────────────────────────────────────────────

export async function cli(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const agentsDir = import.meta.dir + "/agents";

  switch (parsed.command) {
    case "help": {
      printUsage();
      break;
    }

    case "list": {
      const agents = await loadAgents(agentsDir);
      console.log(formatAgentList([...agents.values()]));
      break;
    }

    case "run": {
      if (!parsed.agentName) {
        console.error("Error: agent name required. Usage: ezcorp run <agent-name>");
        process.exit(1);
      }

      await initDb();
      const agents = await loadAgents(agentsDir, { includeDb: true });
      const bus = new EventBus<AgentEvents>();
      const executor = new AgentExecutor(agents, bus, { persist: true });
      const disconnect = connectToEventBus(bus);

      let projectId: string | undefined;
      if (parsed.project) {
        const project = await getProjectByName(parsed.project);
        if (!project) {
          console.error(`Error: project "${parsed.project}" not found`);
          process.exit(1);
        }
        projectId = project.id;
      }

      let input = parsed.input;
      if (!input) {
        const agent = [...agents.values()].find((a) => a.name === parsed.agentName);
        if (agent?.inputSchema) {
          const { promptForInput } = await import("./ui/prompt");
          input = await promptForInput(agent.inputSchema);
        } else {
          input = {};
        }
      }

      try {
        const run = await executor.runAgent(parsed.agentName, input, projectId);
        console.log(JSON.stringify(run.result, null, 2));
      } finally {
        disconnect();
      }
      break;
    }

    case "pipeline:list": {
      await initDb();
      const yamlPipelines = await loadYamlPipelines(agentsDir);
      const dbPipelines = await loadDbPipelines();
      const all = [...yamlPipelines, ...dbPipelines];

      if (all.length === 0) {
        console.log("No pipelines found.");
      } else {
        for (const p of all) {
          console.log(`  ${p.name.padEnd(30)} ${p.description} (${p.steps.length} steps)`);
        }
      }
      break;
    }

    case "pipeline:run": {
      if (!parsed.pipelineName) {
        console.error("Error: pipeline name required. Usage: pi pipeline run <name>");
        process.exit(1);
      }

      await initDb();
      const agents = await loadAgents(agentsDir, { includeDb: true });
      const bus = new EventBus<AgentEvents>();
      const executor = new AgentExecutor(agents, bus, { persist: true });
      const pipelineExec = new PipelineExecutor(executor, bus);
      const disconnect = connectToEventBus(bus);

      const yamlPipelines = await loadYamlPipelines(agentsDir);
      const dbPipelines = await loadDbPipelines();
      const allPipelines = [...yamlPipelines, ...dbPipelines];
      const pipeline = allPipelines.find((p) => p.name === parsed.pipelineName);

      if (!pipeline) {
        console.error(`Error: pipeline "${parsed.pipelineName}" not found`);
        process.exit(1);
      }

      let projectId: string | undefined;
      if (parsed.project) {
        const project = await getProjectByName(parsed.project);
        if (!project) {
          console.error(`Error: project "${parsed.project}" not found`);
          process.exit(1);
        }
        projectId = project.id;
      }

      try {
        const run = await pipelineExec.runPipeline(pipeline, parsed.input ?? {}, projectId);
        console.log(JSON.stringify(run.result, null, 2));
      } finally {
        disconnect();
      }
      break;
    }

    case "ext:init": {
      const { initExtension } = await import("./extensions/sdk/init");
      try {
        await initExtension({
          extName: parsed.extName,
          type: parsed.type as "tool" | "skill" | "agent" | "multi" | undefined,
        });
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "ext:install": {
      if (!parsed.source) {
        console.error("Error: source required. Usage: ezcorp ext install <source> [--yes]");
        process.exit(1);
      }

      await initDb();

      try {
        const { existsSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const resolvedPath = resolve(parsed.source);
        const isLocalPath = existsSync(resolve(resolvedPath, "ezcorp.config.ts")) ||
          existsSync(resolve(resolvedPath, "ezcorp.config.js"));

        if (isLocalPath) {
          const { loadManifest } = await import("./extensions/loader");
          const manifest = await loadManifest(resolvedPath);
          let permissions: ExtensionPermissions = { grantedAt: {} };
          try {
            permissions = await promptForPermissions(manifest as unknown as ExtensionManifestV2, !!parsed.autoApprove);
          } catch { /* use default empty permissions */ }
          const ext = await installFromLocal(resolvedPath, permissions, true);
          console.log(`Installed ${ext.name} v${ext.version} from ${parsed.source}`);
        } else {
          const extensionsDir = process.env.__EZCORP_TEST_EXTENSIONS_DIR;
          const { root, dependencies } = await installWithDependencies(
            parsed.source,
            { grantedAt: {} }, // base permissions; onPermissionPrompt overrides
            {
              ...(extensionsDir ? { extensionsDir } : {}),
              enabled: true,
              onConfirm: async (tree: string, _count: number) => {
                if (parsed.autoApprove) return true;
                console.log(`\nDependency tree:\n${tree}`);
                return true;
              },
              onPermissionPrompt: async (manifest: ExtensionManifestV2) => {
                return promptForPermissions(manifest, !!parsed.autoApprove);
              },
            },
          );

          if (dependencies.length > 0) {
            console.log(`Installed ${root.name} v${root.version} with ${dependencies.length} dependencies`);
          } else {
            console.log(`Installed ${root.name} v${root.version} from ${parsed.source}`);
          }
        }
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "ext:update": {
      await initDb();

      const checkDependentCompat = async (updatedName: string, newVersion: string) => {
        const allExts = await listExtensions();
        for (const other of allExts) {
          const otherManifest = other.manifest as ExtensionManifestV2;
          if (!otherManifest.dependencies) continue;
          for (const [depName, depSpec] of Object.entries(otherManifest.dependencies)) {
            if (depName === updatedName && !satisfiesRange(newVersion, depSpec.version)) {
              console.log(`Warning: ${other.name} requires ${updatedName} ${depSpec.version} but ${newVersion} is installed`);
            }
          }
        }
      };

      if (parsed.extName) {
        try {
          const result = await updateExt(parsed.extName);
          console.log(`Updated ${parsed.extName}: ${result.from} -> ${result.to}`);
          await checkDependentCompat(parsed.extName, result.to);
        } catch (err: unknown) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      } else {
        // Update all extensions
        const exts = await listExtensions();
        if (exts.length === 0) {
          console.log("No extensions installed.");
          break;
        }

        let updated = 0;
        for (const ext of exts) {
          try {
            const check = await checkForUpdates(ext);
            if (check.available) {
              const result = await updateExt(ext.name);
              console.log(`Updated ${ext.name}: ${result.from} -> ${result.to}`);
              await checkDependentCompat(ext.name, result.to);
              updated++;
            }
          } catch (err: unknown) {
            console.error(`Failed to update ${ext.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (updated === 0) {
          console.log("All extensions are up to date.");
        }
      }
      break;
    }

    case "ext:list": {
      await initDb();
      const exts = await listExtensions();

      if (exts.length === 0) {
        console.log("No extensions installed.");
        break;
      }

      // Header
      console.log(
        `${"Name".padEnd(25)} ${"Version".padEnd(10)} ${"Source".padEnd(35)} ${"Status".padEnd(10)} ${"Deps"}`
      );
      console.log("-".repeat(88));

      for (const ext of exts) {
        const manifest = ext.manifest as ExtensionManifestV2;
        const status = ext.enabled ? "enabled" : "disabled";
        const source = ext.source.length > 33 ? ext.source.slice(0, 30) + "..." : ext.source;
        const depCount = manifest.dependencies ? Object.keys(manifest.dependencies).length : 0;
        console.log(
          `${ext.name.padEnd(25)} ${ext.version.padEnd(10)} ${source.padEnd(35)} ${status.padEnd(10)} ${depCount}`
        );
      }
      break;
    }

    case "ext:remove": {
      if (!parsed.extName) {
        console.error("Error: extension name required. Usage: ezcorp ext remove <name> [--force]");
        process.exit(1);
      }

      await initDb();

      // Check for dependents
      const dependents = await findDependents(parsed.extName);

      if (dependents.length > 0 && !parsed.force) {
        console.error(`Cannot remove ${parsed.extName}: required by ${dependents.join(", ")}`);
        process.exit(1);
      }

      if (dependents.length > 0 && parsed.force) {
        console.log(`Force removing ${parsed.extName} (required by ${dependents.join(", ")})`);
      }

      try {
        await removeExt(parsed.extName);
        console.log(`Removed ${parsed.extName}`);
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "ext:info": {
      if (!parsed.extName) {
        console.error("Error: extension name required. Usage: ezcorp ext info <name>");
        process.exit(1);
      }

      await initDb();

      const ext = await getExtensionByName(parsed.extName);
      if (!ext) {
        console.error(`Error: extension "${parsed.extName}" not found`);
        process.exit(1);
      }

      const manifest = ext.manifest as ExtensionManifestV2;
      const permItems = getRequiredPermissions(manifest);

      console.log(`\nExtension: ${ext.name}`);
      console.log(`Version:   ${ext.version}`);
      console.log(`Description: ${ext.description || "(none)"}`);
      console.log(`Author:    ${manifest.author?.name || "(unknown)"}`);
      console.log(`Source:    ${ext.source}`);
      console.log(`Path:      ${ext.installPath}`);
      console.log(`Status:    ${ext.enabled ? "enabled" : "disabled"}`);

      if (permItems.length > 0) {
        console.log(`\nPermissions:`);
        for (const p of permItems) {
          console.log(`  - ${p.description}`);
        }
      }

      if (manifest.tools && manifest.tools.length > 0) {
        console.log(`\nTools:`);
        for (const t of manifest.tools) {
          console.log(`  - ${t.name}: ${t.description}`);
        }
      }

      if (manifest.skills && manifest.skills.length > 0) {
        console.log(`\nSkills:`);
        for (const s of manifest.skills) {
          console.log(`  - ${s.name}: ${s.description}`);
        }
      }

      if (manifest.agent) {
        console.log(`\nAgent: yes (${manifest.agent.category || "uncategorized"})`);
      }

      // Fetch all extensions once for both dependency tree and reverse deps
      const allExtsForInfo = await listExtensions();

      // Show dependency tree
      if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
        console.log(`\nDependencies:`);
        const children: DependencyTreeNode[] = [];

        for (const [depName, depSpec] of Object.entries(manifest.dependencies)) {
          const depExt = allExtsForInfo.find((e) => e.name === depName);
          const depVersion = depExt?.version ?? "not installed";
          const satisfied = depExt ? satisfiesRange(depExt.version, depSpec.version) : false;
          const statusMark = depExt ? (satisfied ? "ok" : "incompatible") : "missing";
          children.push({
            name: depName,
            version: depVersion,
            status: satisfied ? "already-installed" : "install",
            children: [],
          });
          console.log(`  ${depName} ${depSpec.version} [${statusMark}]`);
        }
      }

      // Show "Required by" section
      {
        const requiredBy = await findDependents(parsed.extName, allExtsForInfo);
        if (requiredBy.length > 0) {
          console.log(`\nRequired by: ${requiredBy.join(", ")}`);
        }
      }

      console.log("");
      break;
    }

    case "ext:publish": {
      const { publishExtension } = await import("./extensions/sdk/publish");
      try {
        await publishExtension({ token: parsed.token });
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "ext:dev": {
      const { startDevServer } = await import("./extensions/sdk/dev");
      await startDevServer({ extDir: parsed.extDir });
      break;
    }

    case "ext:test": {
      const { runExtensionTests } = await import("./extensions/sdk/test-runner");
      const code = await runExtensionTests({ extDir: parsed.extDir, filter: parsed.filter });
      process.exit(code);
      break;
    }

    case "serve": {
      const isDev = !Bun.argv.includes("--prod");
      const webDir = import.meta.dir + "/../web";

      if (isDev) {
        const proc = Bun.spawn(["bun", "run", "dev", "--port", String(parsed.port ?? 3001)], {
          cwd: webDir,
          stdio: ["inherit", "inherit", "inherit"],
          env: { ...process.env },
        });
        process.on("SIGTERM", () => proc.kill());
        process.on("SIGINT", () => proc.kill());
        await proc.exited;
      } else {
        const proc = Bun.spawn(["bun", "./build/index.js"], {
          cwd: webDir,
          stdio: ["inherit", "inherit", "inherit"],
          env: { ...process.env, PORT: String(parsed.port ?? 3001) },
        });
        process.on("SIGTERM", () => proc.kill());
        process.on("SIGINT", () => proc.kill());
        await proc.exited;
      }
      break;
    }
  }
}

if (import.meta.main) {
  cli(process.argv.slice(2));
}
