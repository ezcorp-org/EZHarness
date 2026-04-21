#!/usr/bin/env bun
/**
 * Postinstall scaffold for the ai-kit extension.
 *
 * Creates the extension data directory under the project root so that the
 * extension has a stable home for any future user-visible files (logs,
 * cached configs, etc.).  This is a touch-level scaffold — it only makes
 * the directory; it does NOT write any config files.
 *
 * Follows the Data Storage Convention:
 *   <projectRoot>/.ezcorp/extension-data/ai-kit/
 *
 * See: docs/extensions/data-storage.md
 */

import { getExtensionDataDir, findProjectRoot } from "@ezcorp/sdk/runtime";

// getExtensionDataDir walks up from cwd to find .git, then creates
// <projectRoot>/.ezcorp/extension-data/ai-kit/ (recursive mkdirSync inside).
const dataDir = getExtensionDataDir("ai-kit");
const projectRoot = findProjectRoot();

console.log(`ai-kit: data directory initialized at ${dataDir}`);
console.log(`  (project root: ${projectRoot})`);
