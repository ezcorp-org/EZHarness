/**
 * CLI config file management (~/.ezcorp/config.json).
 * Stores publish tokens and other CLI configuration.
 */

import { join } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";

export interface PiConfig {
  publishToken?: string;
  [key: string]: unknown;
}

/** Resolve the config directory. Uses _configDir override or $HOME/.ezcorp. */
function getConfigDir(overrideDir?: string): string {
  return overrideDir ?? join(process.env.HOME ?? "/tmp", ".ezcorp");
}

function getConfigPath(overrideDir?: string): string {
  return join(getConfigDir(overrideDir), "config.json");
}

/**
 * Read CLI config from ~/.ezcorp/config.json.
 * Returns empty object if file doesn't exist.
 */
export async function readConfig(configDir?: string): Promise<PiConfig> {
  const file = Bun.file(getConfigPath(configDir));
  if (!(await file.exists())) return {};
  return file.json();
}

/**
 * Write CLI config to ~/.ezcorp/config.json with 0600 permissions.
 * Creates ~/.ezcorp/ directory if it doesn't exist.
 */
export async function writeConfig(config: PiConfig, configDir?: string): Promise<void> {
  const dir = getConfigDir(configDir);
  const configPath = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  await Bun.write(configPath, JSON.stringify(config, null, 2));
  chmodSync(configPath, 0o600);
}

/**
 * Get publish token from flag override or config file.
 * Returns null if no token found anywhere.
 */
export async function getPublishToken(flagToken?: string, configDir?: string): Promise<string | null> {
  if (flagToken) return flagToken;
  const config = await readConfig(configDir);
  return config.publishToken ?? null;
}
