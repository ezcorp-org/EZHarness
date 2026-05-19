// ── Extension Init Scaffolding ──────────────────────────────────
//
// CLI wrapper around `scaffoldExtension`. The pure scaffolder lives in
// `./scaffold.ts` and is exposed via `@ezcorp/sdk` so the bundled
// `extension-author` extension can use the same primitive without going
// through fs writes here. This wrapper handles:
//   - the interactive prompt path (`extName` + no `type` flag)
//   - directory existence + creation
//   - file writes via `Bun.write`
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { askLine } from "../../ui/prompt";
import { logger } from "../../logger";
import { scaffoldExtension, EXT_TYPES, type ExtType } from "./scaffold";
const log = logger.child("ext-sdk");

export interface InitOptions {
  extName?: string;
  type?: ExtType;
  description?: string;
  /** Override working directory (used by tests). Defaults to process.cwd() */
  cwd?: string;
}

export async function initExtension(opts: InitOptions): Promise<void> {
  if (!opts.extName) {
    throw new Error('Extension name required. Usage: ezcorp ext init <name> [--type tool|skill|agent|multi]');
  }

  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(cwd, opts.extName);

  if (existsSync(targetDir)) {
    throw new Error(`Directory "${opts.extName}" already exists`);
  }

  let extType = opts.type;
  let description = opts.description ?? "An ezcorp extension";

  // Interactive wizard if no --type provided
  if (!extType) {
    const descAnswer = await askLine(`Description (${description}): `);
    if (descAnswer.trim()) description = descAnswer.trim();

    log.info("Extension type: 1) Tool - MCP tool server, 2) Skill - Prompt & knowledge, 3) Agent - Conversational persona, 4) Multi - Combined");

    const typeAnswer = await askLine("\nSelect type [1-4]: ");
    const typeIdx = parseInt(typeAnswer.trim(), 10) - 1;
    extType = EXT_TYPES[typeIdx] ?? "tool";
  }

  // Pure scaffold — returns { files: Record<relpath, content> }.
  // Throws on bad name or type; the call site will surface the message.
  const { files } = scaffoldExtension({
    name: opts.extName,
    type: extType,
    description,
  });

  // Create directory
  mkdirSync(targetDir, { recursive: true });

  // Write files using Bun.write. Order is preserved from the scaffold
  // result; the file set is the same regardless of write order.
  const writes: Promise<number>[] = Object.entries(files).map(([relpath, content]) =>
    Bun.write(join(targetDir, relpath), content),
  );

  await Promise.all(writes);

  log.info("Created extension", { name: opts.extName, path: `./${opts.extName}/` });
  log.info(`Next: cd ${opts.extName} && bun install`);
}
