import { loadManifestFresh } from "../loader";

export interface DevServerOptions {
  extDir?: string;
  _signal?: AbortSignal;
}

export async function startDevServer(opts?: DevServerOptions): Promise<void> {
  await loadManifestFresh(opts?.extDir ?? process.cwd());
}
