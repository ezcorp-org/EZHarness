import { serve } from "@ezcorp/sdk/v4";
import { localSandboxExtension } from "./provider";

export async function start(run = serve): Promise<void> { await run(localSandboxExtension); }
if (import.meta.main) await start();
