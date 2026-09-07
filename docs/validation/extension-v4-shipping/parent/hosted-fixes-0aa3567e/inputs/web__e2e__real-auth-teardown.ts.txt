/**
 * Real-auth Playwright globalTeardown.
 *
 * The preview wrapper owns default temporary database roots and removes them
 * after the preview exits. Global teardown runs before Playwright shuts down
 * `webServer`, so it only removes the runner-side storage state here.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.join(__dirname, ".real-auth.json");

export default async function globalTeardown(): Promise<void> {
  if (existsSync(STORAGE_STATE_PATH)) {
    await unlink(STORAGE_STATE_PATH);
  }
}
