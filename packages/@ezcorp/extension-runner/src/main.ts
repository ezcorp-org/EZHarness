import { readFile } from "node:fs/promises";
import { PodmanRunner } from "./podman";
import { provisionToolchain } from "./provision";
import { startRunnerService } from "./service";

const socketPath = process.env.EZ_EXTENSION_RUNNER_SOCKET;
const tokenFile = process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE;
const root = process.env.EZ_EXTENSION_RUNNER_STORE;
const allowedUid = Number(process.env.EZ_EXTENSION_APP_UID);
if (!socketPath || !tokenFile || !root || !process.env.EZ_EXTENSION_APP_UID) throw new Error("Configure runner socket, token file, store and exact application UID");
const token = (await readFile(tokenFile, "utf8")).trim();
export const runner = new PodmanRunner({ root, image: process.env.EZ_EXTENSION_RUNNER_IMAGE, ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_EXTENSION_RUNNER_SDK_ENTRY }) });
await runner.initialize();
export const service = await startRunnerService({ runner, socketPath, token, allowedUid });
let stopping = false;
export async function stopRunner(exit: (code: number) => void = process.exit): Promise<void> {
  if (stopping) return;
  stopping = true;
  await service.close().then(() => runner.close()).then(() => exit(0), () => exit(1));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stopRunner(); });
