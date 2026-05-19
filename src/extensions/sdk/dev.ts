/**
 * Extension dev server with hot reload.
 * Registers extension with platform, watches for file changes, and auto-reloads.
 */

import { watch, type FSWatcher } from "node:fs";
import { loadManifestFresh } from "../loader";
import { installFromLocal } from "../installer";
import { ExtensionRegistry } from "../registry";
import { listExtensions, deleteExtension } from "../../db/queries/extensions";
import { initDb } from "../../db/connection";
import { logger } from "../../logger";
const log = logger.child("ext-dev");

export interface DevServerOptions {
  extDir?: string;
  /** Internal: abort signal for testing (replaces SIGINT/SIGTERM). */
  _signal?: AbortSignal;
}

export async function startDevServer(opts?: DevServerOptions): Promise<void> {
  const extDir = opts?.extDir ?? process.cwd();

  // Read and validate manifest (cache-busting for dev reload)
  const manifestData = await loadManifestFresh(extDir);
  const manifest = manifestData as { name: string; version: string };

  // Initialize DB
  await initDb();

  // Clean up stale dev entries
  const allExts = await listExtensions();
  for (const ext of allExts) {
    if (ext.source.startsWith("dev:local:")) {
      await deleteExtension(ext.id);
    }
  }

  // Register extension via installFromLocal (dev mode auto-approves all permissions)
  const installed = await installFromLocal(extDir, { grantedAt: {} }, true);

  // Print banner
  log.info("Dev server started", { name: manifest.name, version: manifest.version, dir: extDir });

  // File watcher with debounce
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const reload = async () => {
    const start = performance.now();
    log.info("Reloading...");
    try {
      const registry = ExtensionRegistry.getInstance();
      // Kill existing process if running
      try {
        const proc = await registry.getProcess(installed.id);
        proc.kill();
      } catch {
        // Process may not exist yet
      }
      // Reload registry to pick up manifest changes
      await registry.reload();
      const elapsed = (performance.now() - start).toFixed(0);
      log.info("Extension reloaded", { elapsedMs: elapsed });
    } catch (err) {
      log.error("Reload failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  watcher = watch(extDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Ignore node_modules and dotfiles
    if (filename.includes("node_modules")) return;
    if (filename.startsWith(".") || filename.includes("/.")) return;

    // Debounce: 100ms
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, 100);
  });

  // Cleanup function
  const cleanup = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    // Remove dev DB record
    try {
      await deleteExtension(installed.id);
    } catch {
      // May already be cleaned up
    }
    // Kill all extension processes
    try {
      ExtensionRegistry.getInstance().killAll();
    } catch {
      // Registry may not be initialized
    }
  };

  // Handle shutdown signals. Check `aborted` first — if the signal fired during
  // startup (e.g. a slow first-invocation dynamic import racing the test's
  // controller.abort() 50ms after spawn), `addEventListener("abort", ...)` will
  // never invoke the listener because AbortSignal events are one-shot and
  // already delivered. Without this guard, the keep-alive Promise below would
  // hang forever and the caller would time out.
  if (opts?._signal) {
    if (opts._signal.aborted) {
      await cleanup();
      return;
    }
    opts._signal.addEventListener("abort", () => {
      cleanup();
    }, { once: true });
  } else {
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });
  }

  // Keep process alive (or wait for abort signal). The `aborted` check above
  // already returned early if the signal fired during startup, so by here the
  // listener is guaranteed to run.
  if (opts?._signal) {
    await new Promise<void>((resolve) => {
      opts._signal!.addEventListener("abort", () => resolve(), { once: true });
    });
  } else {
    await new Promise(() => {}); // Never resolves
  }
}
