/**
 * Test helper: write an ezcorp.config.ts file to a directory.
 * Converts a manifest object to a TypeScript default export string.
 */
import { join } from "path";

export function configContent(manifest: object): string {
  return `export default ${JSON.stringify(manifest, null, 2)};\n`;
}

export async function writeConfig(dir: string, manifest: object): Promise<void> {
  await Bun.write(join(dir, "ezcorp.config.ts"), configContent(manifest));
}
